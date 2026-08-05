window.processor.onProcess(async (payload) => {
  const { id, dataUrl, masks } = payload;
  try {
    const img = new Image();
    img.src = dataUrl;
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; });
    const cv = document.getElementById('cv');
    cv.width = img.naturalWidth;
    cv.height = img.naturalHeight;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0);
    ctx.fillStyle = '#000000';
    for (const m of masks || []) {
      ctx.fillRect(m.x * cv.width, m.y * cv.height, m.w * cv.width, m.h * cv.height);
    }
    window.processor.resolveProcess(id, cv.toDataURL('image/jpeg', 0.8));
  } catch (err) {
    window.processor.errorProcess(id, String(err));
  }
});
