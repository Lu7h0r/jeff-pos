import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth-guard";

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
]);

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
};

export async function POST(request: Request) {
  const user = await getAuthUser();

  if (!user) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const formData = await request.formData();
  const file = formData.get("file");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No se encontró ningún archivo" }, { status: 400 });
  }

  if (!ALLOWED_MIME_TYPES.has(file.type)) {
    return NextResponse.json({ error: "Formato no permitido. Usa PNG, JPG o WEBP" }, { status: 400 });
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    return NextResponse.json({ error: "La imagen supera el límite de 5 MB" }, { status: 400 });
  }

  const ext = EXT_BY_MIME[file.type] ?? "jpg";
  const fileName = `${Date.now()}-${randomUUID()}.${ext}`;
  const uploadDir = join(process.cwd(), "public", "uploads", "products");
  const diskPath = join(uploadDir, fileName);

  await mkdir(uploadDir, { recursive: true });
  const bytes = await file.arrayBuffer();
  await writeFile(diskPath, Buffer.from(bytes));

  const url = `/uploads/products/${fileName}`;

  return NextResponse.json({ url });
}
