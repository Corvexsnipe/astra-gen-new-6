export class UploadError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export async function readApplicationDocuments(form: FormData) {
  const fields = [
    ['identityCardFront', 'Identity card front', true, false],
    ['identityCard', 'Identity card back', true, false],
    ['passportPhoto', 'Passport photo', true, false],
    ['experienceLetter', 'Experience letter', false, true],
  ] as const;
  const documents: Record<string, string | null> = {};
  for (const [name, label, required, pdf] of fields) {
    const file = form.get(name);
    if (!file || (file instanceof File && file.size === 0 && !file.name)) {
      if (required) throw new UploadError(`${label} is required.`);
      documents[name] = null;
      continue;
    }
    if (!(file instanceof File) || file.size === 0) throw new UploadError(`${label}: select a valid file.`);
    if (file.size > 5 * 1024 * 1024) throw new UploadError(`${label} must be 5 MB or smaller.`, 413);
    const bytes = Buffer.from(await file.arrayBuffer());
    const isPdf = file.type === 'application/pdf' && bytes.subarray(0, 5).toString() === '%PDF-';
    const isPng = file.type === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const isJpeg = file.type === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (pdf ? !isPdf : !isPng && !isJpeg) throw new UploadError(`${label} must be ${pdf ? 'a PDF document' : 'a JPG or PNG picture'}.`);
    documents[name] = bytes.toString('base64');
  }
  return documents;
}
