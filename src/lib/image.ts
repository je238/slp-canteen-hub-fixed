// Phone cameras produce 4–12 MB photos. Base64 inflates that by a third and
// the whole thing then has to reach an edge function — which is exactly where
// "the upload just doesn't work" comes from on a real phone on mobile data.
// Nothing downstream benefits from that size: the OCR reads a 1600px image
// just as well, and it arrives in a second instead of failing.

const MAX_EDGE = 1600;
const QUALITY = 0.82;

/** Resize + re-encode to JPEG. Returns the original if it can't be decoded. */
export async function compressImage(file: File, maxEdge = MAX_EDGE): Promise<File> {
  if (!file.type.startsWith("image/")) return file;          // PDFs pass through
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 1_500_000) return file;    // already small

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();

    const blob: Blob | null = await new Promise((res) =>
      canvas.toBlob(res, "image/jpeg", QUALITY)
    );
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch {
    return file;
  }
}

/** Compress, then hand back the base64 the OCR function expects. */
export async function toCompressedBase64(
  file: File,
  maxEdge = MAX_EDGE,
): Promise<{ base64: string; mimeType: string; sizeKb: number }> {
  const small = await compressImage(file, maxEdge);
  const base64: string = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve((r.result as string).split(",")[1]);
    r.onerror = reject;
    r.readAsDataURL(small);
  });
  return { base64, mimeType: small.type, sizeKb: Math.round(small.size / 1024) };
}
