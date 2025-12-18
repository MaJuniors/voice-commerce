// ====== KONFIG BACKEND ======
const API_BASE = `${location.origin}/api`;   // semua API lewat /api

// ====== ELEMEN UI ======
const logBox  = document.getElementById('log');
const micBtn  = document.getElementById('micBtn');
const player  = document.getElementById('player');
let productsContainer = document.getElementById('products');

// Kalau belum ada <section id="products"> di HTML, buat otomatis
if (!productsContainer) {
  const main = document.querySelector('main') || document.body;
  productsContainer = document.createElement('section');
  productsContainer.id = 'products';
  productsContainer.className = 'products';
  main.appendChild(productsContainer);
}

// ====== STATE REKAMAN ======
let isRecording = false;
let audioCtx, processor, mediaStream;
let chunks = [];
const SR = 16000;

// ====== UTIL LOG & BEEP ======
function log(line, cls='') {
  const p = document.createElement('div');
  p.textContent = line;
  if (cls) p.className = cls;
  logBox.appendChild(p);
  logBox.scrollTop = logBox.scrollHeight;
}

function beep(start=true){
  try{
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.value = start ? 1200 : 800;
    g.gain.value = 0.08;
    o.connect(g); g.connect(ctx.destination);
    o.start();
    setTimeout(()=>{ o.stop(); ctx.close(); }, 110);
    if (navigator.vibrate) navigator.vibrate(30);
  }catch(e){}
}

// ====== FETCH HELPER (AMAN UNTUK JSON / ERROR) ======
async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  const raw = await res.text(); // baca sekali

  // kalau status bukan 2xx -> lempar error lengkap
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} @ ${url} | ${raw.slice(0,200)}`);
  }

  // pastikan JSON beneran
  if (!ct.includes("application/json")) {
    throw new Error(`Non-JSON response @ ${url} | ${raw.slice(0,200)}`);
  }

  // parse JSON aman
  try {
    return JSON.parse(raw || "{}");
  } catch (e) {
    throw new Error(`JSON parse error @ ${url} | ${raw.slice(0,200)}`);
  }
}

// ====== ENCODE PCM16 KE WAV ======
function encodeWav(samples, sampleRate){
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr=(off,s)=>{for(let i=0;i<s.length;i++) view.setUint8(off+i, s.charCodeAt(i));};

  writeStr(0,'RIFF'); view.setUint32(4,36+samples.length*2,true);
  writeStr(8,'WAVE'); writeStr(12,'fmt ');
  view.setUint32(16,16,true); view.setUint16(20,1,true);
  view.setUint16(22,1,true);
  view.setUint32(24,sampleRate,true);
  view.setUint32(28,sampleRate*2,true);
  view.setUint16(32,2,true); view.setUint16(34,16,true);
  writeStr(36,'data'); view.setUint32(40,samples.length*2,true);

  let idx=44;
  for(let i=0;i<samples.length;i++, idx+=2){
    let s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(idx, s<0 ? s*0x8000 : s*0x7FFF, true);
  }
  return new Blob([view], {type:'audio/wav'});
}

// ====== RENDER KARTU PRODUK (TANPA MENGHAPUS HISTORY) ======
function renderProductsBlock(qText, data){
  if (!data || !Array.isArray(data.items) || data.items.length === 0) {
    const msg = document.createElement('p');
    msg.className = 'products-title';
    msg.textContent = `Tidak ada hasil Tokopedia untuk "${qText}".`;
    productsContainer.appendChild(msg);
    return;
  }

  const block = document.createElement('div');
  block.className = 'products-block';

  const title = document.createElement('h2');
  title.textContent = `Hasil Tokopedia untuk "${qText}"`;
  title.className = 'products-title';
  block.appendChild(title);

  const wrap = document.createElement('div');
  wrap.className = 'products-row';
  block.appendChild(wrap);

  data.items.forEach(it => {
    const card = document.createElement('article');
    card.className = 'product-card';

    if (it.image) {
      const img = document.createElement('img');
      img.src = it.image;
      img.alt = it.name || 'Produk Tokopedia';
      img.className = 'product-img';
      card.appendChild(img);
    }

    const name = document.createElement('h3');
    name.className = 'product-name';
    name.textContent = it.name || '(tanpa nama)';
    card.appendChild(name);

    const price = document.createElement('p');
    price.className = 'product-price';
    price.textContent = it.price || 'Rp -';
    card.appendChild(price);

    const btn = document.createElement('a');
    btn.className = 'product-btn';
    btn.href = it.url || '#';
    btn.target = '_blank';
    btn.rel = 'noopener noreferrer';
    btn.textContent = 'Beli di Tokopedia';
    card.appendChild(btn);

    wrap.appendChild(card);
  });

  productsContainer.appendChild(block);
}

// ====== REKAM ======
async function startRecording(){
  if (isRecording) return;
  isRecording = true;
  micBtn.classList.add('recording');
  beep(true);

  log('[REC] Mulai merekam…');

  chunks = [];
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount:1, sampleRate: SR }
  });
  audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SR });
  const source = audioCtx.createMediaStreamSource(mediaStream);
  processor = audioCtx.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = e => {
    chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  };
  source.connect(processor);
  processor.connect(audioCtx.destination);
}

async function stopRecording(){
  if (!isRecording) return;
  isRecording = false;
  micBtn.classList.remove('recording');
  beep(false);

  try { processor.disconnect(); } catch(e){}
  try { await audioCtx.close(); } catch(e){}
  try { mediaStream.getTracks().forEach(t => t.stop()); } catch(e){}

  let len = chunks.reduce((a,b)=>a+b.length,0);
  let merged = new Float32Array(len);
  let off = 0;
  for (const c of chunks){ merged.set(c,off); off += c.length; }

  const wav = encodeWav(merged, SR);
  log('[REC] Selesai. Upload ke server…');

  // 1) STT
  const form = new FormData();
  form.append('file', wav, 'audio.wav');

  let sttText = '';
  try{
    const stt = await fetchJson(`${API_BASE}/stt`, { method:'POST', body: form });
    sttText = (stt.text || '').trim();
    log('[STT] ' + (sttText || '(kosong)'));
  }catch(e){
    log('[ERR] Gagal STT: ' + e.message);
  }

  if (!sttText) return;

  // 2) Reply (TTS dari server)
  try{
    const body = new URLSearchParams({ text: sttText });
    const res = await fetch(`${API_BASE}/reply`, { method:'POST', body });

    if (!res.ok) {
      const raw = await res.text();
      throw new Error(`Reply HTTP ${res.status}: ${raw.slice(0,200)}`);
    }

    const mp3 = await res.blob();
    const url = URL.createObjectURL(mp3);
    player.src = url;
    player.hidden = false;
    await player.play();
    log('[TTS] Diputar.', 'b');
  }catch(e){
    log('[ERR] Gagal memutar balasan: '+e.message);
  }

  // 3) Tokopedia cards
  try{
    const data = await fetchJson(
      `${API_BASE}/tokopedia/search?q=${encodeURIComponent(sttText)}&limit=3`
    );
    const keywordForTitle = data.keyword || sttText;
    log(`[TOKO] ${data.count} produk ditemukan.`, 'b');
    renderProductsBlock(keywordForTitle, data);
  }catch(e){
    log('[ERR] Gagal ambil produk Tokopedia: '+e.message);
  }
}

// ====== EVENT ======
const downEv = ('onpointerdown' in window) ? 'pointerdown' : 'mousedown';
const upEv   = ('onpointerup' in window)   ? 'pointerup'   : 'mouseup';

micBtn.addEventListener(downEv, (e)=>{
  e.preventDefault();
  startRecording();
}, {passive:false});

micBtn.addEventListener(upEv, (e)=>{
  e.preventDefault();
  stopRecording();
}, {passive:false});

micBtn.addEventListener('touchstart', (e)=>{
  e.preventDefault();
  startRecording();
}, {passive:false});

micBtn.addEventListener('touchend', (e)=>{
  e.preventDefault();
  stopRecording();
}, {passive:false});

window.addEventListener('keydown', (e)=>{
  if ((e.code === 'Space' || e.code === 'Enter') && !isRecording){
    e.preventDefault();
    startRecording();
  }
});

window.addEventListener('keyup', (e)=>{
  if ((e.code === 'Space' || e.code === 'Enter') && isRecording){
    e.preventDefault();
    stopRecording();
  }
});

log('[INFO] Tahan tombol biru untuk bicara, lepas untuk kirim.');
