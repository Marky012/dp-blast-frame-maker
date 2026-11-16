import { OUTPUT_SIZE } from '../config.js';

const MAX_STUDENT_FILE_BYTES = 15 * 1024 * 1024; // 15 MB
const MAX_ADMIN_FRAME_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_PHOTO_DIMENSION = 4000;

/**
 * Loads a student photo File/Blob, respecting EXIF orientation via createImageBitmap
 * with fallback to HTMLImageElement, and downscales if longer side > 4000px.
 */
export async function loadStudentPhoto(file) {
  if (!file) {
    throw new Error('Please select an image file.');
  }

  const isImageType =
    (file.type && file.type.startsWith('image/')) ||
    /\.(jpe?g|png|webp|gif|heic|heif|bmp|avif)$/i.test(file.name || '');

  if (!isImageType) {
    throw new Error('Unsupported file type. Please upload an image file (JPG, PNG, WebP, etc.).');
  }

  if (file.size > MAX_STUDENT_FILE_BYTES) {
    const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
    throw new Error(`Photo is too large (${sizeMb} MB). Maximum allowed size is 15 MB.`);
  }

  let decoded = null;

  // 1. Try createImageBitmap with EXIF orientation support
  if (typeof createImageBitmap === 'function') {
    try {
      decoded = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      try {
        decoded = await createImageBitmap(file);
      } catch {
        decoded = null;
      }
    }
  }

  // 2. Fallback to HTMLImageElement + Object URL (and revoke immediately after load)
  if (!decoded) {
    decoded = await new Promise((resolve, reject) => {
      const objectUrl = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(objectUrl);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error('Could not decode this image file. Please try another photo.'));
      };
      img.src = objectUrl;
    });
  }

  const origWidth = decoded.width || decoded.naturalWidth;
  const origHeight = decoded.height || decoded.naturalHeight;

  if (!origWidth || !origHeight) {
    if (typeof decoded.close === 'function') decoded.close();
    throw new Error('Invalid image dimensions.');
  }

  // 3. Downscale if longer side exceeds MAX_PHOTO_DIMENSION (4000px) to prevent mobile memory crashes
  const maxSide = Math.max(origWidth, origHeight);
  if (maxSide > MAX_PHOTO_DIMENSION) {
    const ratio = MAX_PHOTO_DIMENSION / maxSide;
    const targetW = Math.max(1, Math.round(origWidth * ratio));
    const targetH = Math.max(1, Math.round(origHeight * ratio));

    const offscreen = document.createElement('canvas');
    offscreen.width = targetW;
    offscreen.height = targetH;
    const ctx = offscreen.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(decoded, 0, 0, targetW, targetH);

    if (typeof decoded.close === 'function') {
      decoded.close();
    }

    return {
      drawable: offscreen,
      width: targetW,
      height: targetH,
      wasDownscaled: true,
    };
  }

  return {
    drawable: decoded,
    width: origWidth,
    height: origHeight,
    wasDownscaled: false,
  };
}

/**
 * Renders the composite onto a 1500x1500 canvas context.
 * Draw order:
 *   1. Background color
 *   2. Student photo with pan/zoom/rotate/flip transform
 *   3. Team frame PNG on top
 *   4. Optional preview-only profile crop circle guide
 */
export function renderComposite(ctx, { photo, frameImage, transform, bgColor, showCropGuide = false }) {
  ctx.clearRect(0, 0, OUTPUT_SIZE, OUTPUT_SIZE);

  // (1) Solid background color
  ctx.save();
  ctx.fillStyle = bgColor || '#ffffff';
  ctx.fillRect(0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
  ctx.restore();

  // (2) Student photo behind frame
  if (photo && photo.drawable) {
    const imgW = photo.width;
    const imgH = photo.height;
    const baseCoverScale = Math.max(OUTPUT_SIZE / imgW, OUTPUT_SIZE / imgH);
    const totalScale = baseCoverScale * (transform?.zoom ?? 1);
    const panX = transform?.panX ?? 0;
    const panY = transform?.panY ?? 0;
    const rotation = transform?.rotation ?? 0;
    const flipX = Boolean(transform?.flipX);

    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.translate(OUTPUT_SIZE / 2 + panX, OUTPUT_SIZE / 2 + panY);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.scale(flipX ? -totalScale : totalScale, totalScale);
    ctx.drawImage(photo.drawable, -imgW / 2, -imgH / 2, imgW, imgH);
    ctx.restore();
  }

  // (3) Team frame PNG on top
  if (frameImage) {
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(frameImage, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
    ctx.restore();
  }

  // (4) Preview-only circular profile crop guide (never included in export)
  if (showCropGuide) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.lineWidth = 4;
    ctx.setLineDash([16, 12]);
    ctx.beginPath();
    ctx.arc(OUTPUT_SIZE / 2, OUTPUT_SIZE / 2, OUTPUT_SIZE / 2 - 6, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(15, 23, 42, 0.55)';
    ctx.lineWidth = 2;
    ctx.setLineDash([16, 12]);
    ctx.beginPath();
    ctx.arc(OUTPUT_SIZE / 2, OUTPUT_SIZE / 2, OUTPUT_SIZE / 2 - 10, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

/**
 * Exports the composite to a PNG Blob at full OUTPUT_SIZE (1500x1500) without crop guides.
 */
export function exportCompositeBlob({ photo, frameImage, transform, bgColor }) {
  return new Promise((resolve, reject) => {
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = OUTPUT_SIZE;
    exportCanvas.height = OUTPUT_SIZE;
    const ctx = exportCanvas.getContext('2d');

    renderComposite(ctx, {
      photo,
      frameImage,
      transform,
      bgColor,
      showCropGuide: false,
    });

    exportCanvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Failed to generate PNG image.'));
        return;
      }
      resolve(blob);
    }, 'image/png');
  });
}

/**
 * Decodes a data URL (e.g. data:image/png;base64,...) synchronously into a Blob.
 */
export function dataUrlToBlob(dataUrl) {
  const [header, base64] = String(dataUrl).split(',');
  const mimeMatch = header.match(/:(.*?);/);
  const mime = mimeMatch ? mimeMatch[1] : 'image/png';
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

/**
 * Synchronously exports the composite to { blob, dataUrl } at full OUTPUT_SIZE
 * so mobile browsers retain user-gesture activation for immediate downloads.
 */
export function exportCompositeSync({ photo, frameImage, transform, bgColor }) {
  const exportCanvas = document.createElement('canvas');
  exportCanvas.width = OUTPUT_SIZE;
  exportCanvas.height = OUTPUT_SIZE;
  const ctx = exportCanvas.getContext('2d');

  renderComposite(ctx, {
    photo,
    frameImage,
    transform,
    bgColor,
    showCropGuide: false,
  });

  const dataUrl = exportCanvas.toDataURL('image/png');
  const blob = dataUrlToBlob(dataUrl);
  return { blob, dataUrl };
}

/**
 * Sanitizes team name for filename: dp-blast-{teamname}.png
 */
export function buildExportFilename(teamName) {
  const slug = String(teamName || 'team')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'team';
  return `dp-blast-${slug}.png`;
}

/**
 * Client-side validation for admin frame upload:
 * - Must be image/png
 * - Max 5 MB
 * - Decodes to exactly 1500x1500
 * - Checks if image has any transparent pixels (alpha < 250) and returns a warning if opaque
 */
export async function validateAdminFrameFile(file) {
  if (!file) {
    return { valid: false, error: 'Please select a PNG file.' };
  }
  if (file.type !== 'image/png' && !/\.png$/i.test(file.name || '')) {
    return { valid: false, error: `Frame must be a ${OUTPUT_SIZE}x${OUTPUT_SIZE} PNG` };
  }
  if (file.size > MAX_ADMIN_FRAME_BYTES) {
    return { valid: false, error: 'Frame PNG exceeds the 5 MB maximum size.' };
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error(`Frame must be a ${OUTPUT_SIZE}x${OUTPUT_SIZE} PNG`));
      el.src = objectUrl;
    });

    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (w !== OUTPUT_SIZE || h !== OUTPUT_SIZE) {
      return {
        valid: false,
        error: `Frame must be a ${OUTPUT_SIZE}x${OUTPUT_SIZE} PNG (uploaded image is ${w}x${h}).`,
      };
    }

    // Check transparency by sampling pixels on an offscreen canvas
    const checkCanvas = document.createElement('canvas');
    checkCanvas.width = OUTPUT_SIZE;
    checkCanvas.height = OUTPUT_SIZE;
    const ctx = checkCanvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, OUTPUT_SIZE, OUTPUT_SIZE);

    let hasTransparentPixel = false;
    for (let i = 3; i < data.length; i += 16) {
      if (data[i] < 250) {
        hasTransparentPixel = true;
        break;
      }
    }

    let optimizedFile = null;
    if (file.size > 3.5 * 1024 * 1024) {
      const reencodedBlob = await new Promise((resolve) =>
        checkCanvas.toBlob((blob) => resolve(blob), 'image/png')
      );
      if (reencodedBlob && reencodedBlob.size < file.size) {
        optimizedFile = new File([reencodedBlob], file.name || 'frame.png', {
          type: 'image/png',
        });
      }
    }

    return {
      valid: true,
      hasTransparency: hasTransparentPixel,
      optimizedFile,
      warning: hasTransparentPixel
        ? null
        : 'Warning: This PNG has no transparent pixels — the student photo behind it will be completely hidden!',
    };
  } catch (err) {
    return { valid: false, error: err.message || `Frame must be a ${OUTPUT_SIZE}x${OUTPUT_SIZE} PNG` };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

