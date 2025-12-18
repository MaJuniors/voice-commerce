from fastapi import FastAPI, UploadFile, File, Form, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from google.cloud import speech, texttospeech
import io, os, re, json, requests
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pathlib import Path
import wave


# ================== FastAPI app ==================
app = FastAPI(title="Voice Commerce PWA Backend")

# ===== CORS =====
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],      # batasi saat deploy
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

SR = 16000  # sample rate audio WAV dari frontend

# =================================================
#                APIFY — TOKOPEDIA
#  Actor: jupri/tokopedia-scraper
# =================================================
APIFY_TOKEN = os.getenv("APIFY_TOKEN", "apify_api_GwHwgel8SW9vFAcHnnYl8md62HmINo3lOsdY")
APIFY_ACTOR = os.getenv("APIFY_ACTOR", "jupri~tokopedia-scraper")
CACHE_PATH = os.getenv("CACHE_PATH", str(Path("/tmp/products_tokopedia_cache.json")))


# ---------- Helper harga & gambar ----------
def _format_idr(val):
    """Normalisasi angka/harga ke format Rupiah (string)."""
    try:
        if isinstance(val, str):
            s = val.strip()
            if s.lower().startswith("rp"):
                return s
            s = s.replace(".", "").replace(",", ".")
            val = float(s)

        v = float(val)
        if v > 10_000_000 and v % 100000 == 0:
            v = v / 100000.0
        return "Rp {:,.0f}".format(v).replace(",", ".")
    except Exception:
        return str(val)


def _normalize_price(raw):
    """
    Terima raw price dari Apify (bisa dict / int / str),
    balikan: (price_value_number / None, price_text_string / None)
    """
    price_val = None
    price_text = None

    if isinstance(raw, dict):
        price_val = (
            raw.get("number")
            or raw.get("value")
            or raw.get("min")
            or raw.get("max")
        )
        price_text = (
            raw.get("text")
            or raw.get("original")
            or raw.get("display")
            or raw.get("formatted")
        )
    else:
        price_val = raw

    if not price_text and price_val is not None:
        price_text = _format_idr(price_val)

    return price_val, price_text


def _normalize_image(raw):
    """
    Terima raw image dari Apify (bisa str / dict / list),
    balikan: url string atau "".
    """
    if not raw:
        return ""

    if isinstance(raw, str):
        return raw

    if isinstance(raw, list) and raw:
        return _normalize_image(raw[0])

    if isinstance(raw, dict):
        return (
            raw.get("url")
            or raw.get("src")
            or raw.get("imageUrl")
            or raw.get("image_url")
            or raw.get("large")
            or raw.get("thumbnail")
            or ""
        )
    return ""


# ---------- Panggil APIFY ----------
def tokopedia_search_via_apify(keyword: str, limit: int = 3):
    """
    Panggil Apify actor Tokopedia dan kembalikan list standar:
    [{name, price (string), price_value (num), url, image}].
    """
    if not (APIFY_TOKEN and APIFY_ACTOR):
        return []

    url = (
        f"https://api.apify.com/v2/acts/"
        f"{APIFY_ACTOR}/run-sync-get-dataset-items?token={APIFY_TOKEN}"
    )

    payload_candidates = [
        {"Query": [keyword], "Limit": max(3, limit)},
        {"query": [keyword], "limit": max(3, limit)},
    ]

    for payload in payload_candidates:
        try:
            r = requests.post(url, json=payload, timeout=60)
            r.raise_for_status()

            if not r.headers.get("content-type", "").startswith("application/json"):
                continue

            data = r.json()
            if not isinstance(data, list) or not data:
                continue

            items = []
            for it in data[:limit]:
                name = it.get("name") or it.get("title") or ""

                raw_price = (
                    it.get("price")
                    or it.get("priceMin")
                    or it.get("price_value")
                    or it.get("price_int")
                )
                price_val, price_str = _normalize_price(raw_price)

                urlp = (
                    it.get("url")
                    or it.get("productUrl")
                    or it.get("product_url")
                    or ""
                )

                raw_img = (
                    it.get("image")
                    or it.get("imageUrl")
                    or it.get("image_url")
                    or it.get("img")
                    or it.get("images")
                )
                img = _normalize_image(raw_img)

                items.append(
                    {
                        "name": name,
                        "price": price_str or "Rp -",
                        "price_value": price_val,
                        "url": urlp,
                        "image": img,
                    }
                )

            if items:
                return items

        except Exception as e:
            print("[APIFY TOKOPEDIA ERROR]", e)
            continue

    return []


# ---------- Cache sederhana di file JSON ----------
def tokopedia_search_cached(keyword: str, limit: int = 3):
    """
    Cache file JSON supaya hemat kredit Apify.
    Key = keyword lowercase, Value = list hasil.
    """
    kw = (keyword or "").strip().lower()
    db = {}
    if os.path.exists(CACHE_PATH):
        try:
            with open(CACHE_PATH, "r", encoding="utf-8") as f:
                db = json.load(f)
        except Exception:
            db = {}

    if kw in db and db[kw]:
        return db[kw][:limit]

    items = tokopedia_search_via_apify(keyword, limit=limit)
    if items:
        db[kw] = items
        try:
            with open(CACHE_PATH, "w", encoding="utf-8") as f:
                json.dump(db, f, ensure_ascii=False, indent=2)
        except Exception:
            pass
    return items


# ===== Google creds from env (Railway friendly) =====
GOOGLE_JSON = os.getenv("GOOGLE_APPLICATION_CREDENTIALS_JSON")
if GOOGLE_JSON and not os.getenv("GOOGLE_APPLICATION_CREDENTIALS"):
    creds_path = Path(__file__).resolve().parent / "gcloud_key.json"
    creds_path.write_text(GOOGLE_JSON, encoding="utf-8")
    os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = str(creds_path)


# =================================================
#                GOOGLE STT
# =================================================
@app.post("/stt")
async def stt(file: UploadFile = File(...)):
    data = await file.read()

    # Decode WAV -> PCM16 (lebih aman untuk Google STT)
    try:
        with wave.open(io.BytesIO(data), "rb") as wf:
            pcm = wf.readframes(wf.getnframes())
            sr = wf.getframerate()
            ch = wf.getnchannels()
    except Exception:
        pcm = data
        sr = SR
        ch = 1

    client = speech.SpeechClient()
    audio = speech.RecognitionAudio(content=pcm)
    config = speech.RecognitionConfig(
        language_code="id-ID",
        encoding=speech.RecognitionConfig.AudioEncoding.LINEAR16,
        sample_rate_hertz=sr,
        audio_channel_count=ch,
        enable_automatic_punctuation=True,
    )
    resp = client.recognize(config=config, audio=audio)

    text = " ".join(
        r.alternatives[0].transcript.strip()
        for r in resp.results
    ) if resp.results else ""

    return {"text": text}


# =================================================
#                GOOGLE TTS
# =================================================
def tts_mp3_bytes(text: str, *, ssml: bool = False, voice="id-ID-Wavenet-A"):
    tts = texttospeech.TextToSpeechClient()
    inp = (
        texttospeech.SynthesisInput(ssml=text)
        if ssml
        else texttospeech.SynthesisInput(text=text)
    )
    voice_sel = texttospeech.VoiceSelectionParams(
        language_code="id-ID",
        name=voice,
    )
    cfg = texttospeech.AudioConfig(
        audio_encoding=texttospeech.AudioEncoding.MP3,
        speaking_rate=0.95,
        pitch=-2.0,
    )
    resp = tts.synthesize_speech(
        input=inp,
        voice=voice_sel,
        audio_config=cfg,
    )
    return resp.audio_content


# =================================================
#                NLU RINGAN
# =================================================
def extract_search_query(user_text: str) -> str:
    t = user_text.lower()
    m = re.search(r"\bcari(?:kan)?\b(.*)", t)
    if m:
        q = m.group(1).strip()
        q = re.sub(r"^(?:kan|in|dong|ya|untuk|produk)\b", "", q).strip()
        return q if q else user_text
    return user_text


# =================================================
#          Endpoint JSON Tokopedia (untuk kartu)
# =================================================
@app.get("/tokopedia/search")
def tokopedia_search_api(q: str = Query(...), limit: int = 3):
    search_kw = extract_search_query(q)
    items = tokopedia_search_cached(search_kw, limit=limit)

    for it in items:
        if not isinstance(it.get("price"), str):
            base = it.get("price_value") or it.get("price") or 0
            it["price"] = _format_idr(base)

        if not isinstance(it.get("image"), str):
            it["image"] = _normalize_image(it.get("image"))

    return {"count": len(items), "items": items, "keyword": search_kw}


# =================================================
#                REPLY (VUI)
# =================================================
@app.post("/reply")
async def reply(text: str = Form(...)):
    user_orig = (text or "").strip()
    user = user_orig.lower()

    if not user:
        bot = "Maaf, saya tidak menangkap suara. Silakan coba lagi."
        mp3 = tts_mp3_bytes(bot)
        return StreamingResponse(io.BytesIO(mp3), media_type="audio/mpeg")

    SEARCH_TRIGGERS = (
        "cari", "carikan", "mencari", "butuh",
        "nyari", "ingin beli", "pengen beli",
        "beli", "harga",
    )

    if any(t in user for t in SEARCH_TRIGGERS):
        kw = extract_search_query(user_orig)
        items = tokopedia_search_cached(kw, limit=3)

        if items:
            ssml = ["<speak>", f"Saya menemukan {len(items)} produk Tokopedia untuk {kw}."]
            for i, it in enumerate(items, 1):
                nama = it.get("name") or "produk"
                harga = it.get("price") or "tidak diketahui"
                ssml.append(f" Produk {i}: {nama}. Harganya sekitar {harga}. <break time='300ms'/>")
            ssml.append(" Ingin saya kirim tautannya?</speak>")
            mp3 = tts_mp3_bytes("".join(ssml), ssml=True)
            return StreamingResponse(io.BytesIO(mp3), media_type="audio/mpeg")

        bot = f"Maaf, belum ada hasil untuk {kw} di Tokopedia. Coba kata kunci lain ya."
        mp3 = tts_mp3_bytes(bot)
        return StreamingResponse(io.BytesIO(mp3), media_type="audio/mpeg")

    if any(w in user for w in ["halo", "hai", "selamat"]):
        bot = "Halo! Mau cari produk apa hari ini? Ucapkan misalnya: cari kacamata hitam."
    else:
        bot = f"Kamu berkata: {user_orig}"

    mp3 = tts_mp3_bytes(bot)
    return StreamingResponse(io.BytesIO(mp3), media_type="audio/mpeg")


# ===== Serve frontend (server/web) =====
WEB_DIR = Path(__file__).resolve().parent / "web"

@app.get("/", include_in_schema=False)
def serve_index():
    return FileResponse(str(WEB_DIR / "index.html"))

@app.get("/app.js", include_in_schema=False)
def serve_app_js():
    return FileResponse(str(WEB_DIR / "app.js"), media_type="application/javascript")

@app.get("/styles.css", include_in_schema=False)
def serve_css():
    return FileResponse(str(WEB_DIR / "styles.css"), media_type="text/css")

@app.get("/manifest.webmanifest", include_in_schema=False)
def serve_manifest():
    return FileResponse(str(WEB_DIR / "manifest.webmanifest"), media_type="application/manifest+json")

@app.get("/sw.js", include_in_schema=False)
def serve_sw():
    return FileResponse(str(WEB_DIR / "sw.js"), media_type="application/javascript")

# kalau kamu punya folder asset lain (misal web/static/, web/icons/, web/assets/)
# ini aman karena path-nya bukan "/"
if (WEB_DIR / "static").exists():
    app.mount("/static", StaticFiles(directory=str(WEB_DIR / "static")), name="static")
