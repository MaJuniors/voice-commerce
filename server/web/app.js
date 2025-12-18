// ====== KONFIG BACKEND ======
const SERVER = `${location.origin}/api`; 

// ====== ELEMEN UI ======
const logBox  = document.getElementById('log');
const micBtn  = document.getElementById('micBtn');
const player  = document.getElementById('player');
let   productsContainer = document.getElementById('products');

// Kalau belum ada <section id="products"> di HTML, buat otomatis
if (!productsContainer) {
  const main = document.querySelector('main');
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
  if (cls) p.className = cls; // 'u' / 'b' dll
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
    setTimeout(()=>{o.stop(); ctx.close();}, 110);
    if (navigator.vibrate) navigator.vibrate(30);
  }catch(e){}
}

// ====== ENCODE PCM16 KE WAV ======
function encodeWav(samples, sampleRate){
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr=(off,s)=>{for(let i=0;i<s.length;i++) view.setUint8(off+i, s.charCodeAt(i));};

  writeStr(0,'RIFF'); view.setUint32(4,36+samples.length*2,true);
  writeStr(8,'WAVE'); writeStr(12,'fmt ');
  view.setUint32(16,16,true); view.setUint16(20,1,true); // PCM
  view.setUint16(22,1,true); // mono
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

  // 1 blok = 1 sesi pencarian
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

    // Gambar produk (kalau tersedia)
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
    price.textContent = it.price || 'Rp -'; // sudah ter-format dari backend
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

  // bereskan audio/stream
  try { processor.disconnect(); } catch(e){}
  try { await audioCtx.close(); } catch(e){}
  try { mediaStream.getTracks().forEach(t => t.stop()); } catch(e){}

  // gabung buffer
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
    const sttRes = await fetch(`${SERVER}/stt`, { method:'POST', body: form });
    const stt = await sttRes.json();
    sttText = (stt.text || '').trim();
    log('[STT] ' + (sttText || '(kosong)'));
  }catch(e){
    log('[ERR] Gagal STT: '+e.message);
  }

  if (!sttText) return;

  // 2) Reply (TTS dari server)
  try{
    const body = new URLSearchParams({ text: sttText });
    const res = await fetch(`${SERVER}/reply`, { method:'POST', body });
    const mp3 = await res.blob();
    const url = URL.createObjectURL(mp3);
    player.src = url;
    player.hidden = false;
    await player.play();
    log('[TTS] Diputar.', 'b');
  }catch(e){
    log('[ERR] Gagal memutar balasan: '+e.message);
  }

  // 3) Ambil hasil Tokopedia & render (TIDAK menghapus history)
  try{
    const res2 = await fetch(
      `${SERVER}/tokopedia/search?q=${encodeURIComponent(sttText)}&limit=3`
    );
    const data = await res2.json();
    const keywordForTitle = data.keyword || sttText;
    log(`[TOKO] ${data.count} produk ditemukan.`, 'b');
    renderProductsBlock(keywordForTitle, data);
  }catch(e){
    log('[ERR] Gagal ambil produk Tokopedia: '+e.message);
  }
}

// ====== EVENT (pointer + keyboard) ======
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

// fallback iOS Safari lama
micBtn.addEventListener('touchstart', (e)=>{
  e.preventDefault();
  startRecording();
}, {passive:false});

micBtn.addEventListener('touchend', (e)=>{
  e.preventDefault();
  stopRecording();
}, {passive:false});

// Keyboard (Space / Enter)
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

// Info awal
log('[INFO] Tahan tombol biru untuk bicara, lepas untuk kirim.');
