import { createHash, createHmac } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

export interface ObjectStorageArtifact {
  objectKey: string;
  bytes: Uint8Array;
  contentType: string;
  metadata: Record<string, string>;
}

export interface ObjectStorageAdapter {
  put(artifact: ObjectStorageArtifact): Promise<{ objectKey: string; bytes: number }>;
  get(objectKey: string): Promise<ObjectStorageArtifact | null>;
  delete(objectKey: string): Promise<{ objectKey: string; deleted: boolean }>;
}

export interface S3CompatibleObjectStorageOptions {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export class InMemoryObjectStorageAdapter implements ObjectStorageAdapter {
  private readonly artifacts = new Map<string, ObjectStorageArtifact>();

  async put(artifact: ObjectStorageArtifact): Promise<{ objectKey: string; bytes: number }> {
    this.artifacts.set(artifact.objectKey, artifact);
    return { objectKey: artifact.objectKey, bytes: artifact.bytes.byteLength };
  }

  async get(objectKey: string): Promise<ObjectStorageArtifact | null> {
    return this.artifacts.get(objectKey) ?? null;
  }

  async delete(objectKey: string): Promise<{ objectKey: string; deleted: boolean }> {
    return { objectKey, deleted: this.artifacts.delete(objectKey) };
  }
}

export class FileSystemObjectStorageAdapter implements ObjectStorageAdapter {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async put(artifact: ObjectStorageArtifact): Promise<{ objectKey: string; bytes: number }> {
    const objectPath = this.resolveObjectPath(artifact.objectKey);
    await mkdir(dirname(objectPath), { recursive: true });
    await writeFile(objectPath, artifact.bytes);
    await writeFile(
      metadataPath(objectPath),
      JSON.stringify(
        {
          objectKey: artifact.objectKey,
          contentType: artifact.contentType,
          metadata: artifact.metadata
        },
        null,
        2
      )
    );
    return { objectKey: artifact.objectKey, bytes: artifact.bytes.byteLength };
  }

  async get(objectKey: string): Promise<ObjectStorageArtifact | null> {
    const objectPath = this.resolveObjectPath(objectKey);
    try {
      const [bytes, metadata] = await Promise.all([readFile(objectPath), readMetadataFile(metadataPath(objectPath))]);
      return {
        objectKey,
        bytes,
        contentType: metadata.contentType,
        metadata: metadata.metadata
      };
    } catch (error) {
      if (isMissingFileError(error)) {
        return null;
      }
      throw error;
    }
  }

  async delete(objectKey: string): Promise<{ objectKey: string; deleted: boolean }> {
    const objectPath = this.resolveObjectPath(objectKey);
    let deleted = false;
    try {
      await unlink(objectPath);
      deleted = true;
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
    try {
      await unlink(metadataPath(objectPath));
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
    return { objectKey, deleted };
  }

  private resolveObjectPath(objectKey: string): string {
    if (objectKey.trim().length === 0 || objectKey.includes("\0")) {
      throw new Error("invalid_object_key");
    }
    const objectPath = resolve(this.root, objectKey);
    if (objectPath !== this.root && !objectPath.startsWith(`${this.root}${sep}`)) {
      throw new Error("object_key_outside_storage_root");
    }
    return objectPath;
  }
}

export class S3CompatibleObjectStorageAdapter implements ObjectStorageAdapter {
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: URL;
  private readonly now: () => Date;

  constructor(private readonly options: S3CompatibleObjectStorageOptions) {
    if (options.bucket.trim().length === 0) {
      throw new Error("s3_bucket_required");
    }
    if (options.region.trim().length === 0) {
      throw new Error("s3_region_required");
    }
    if (options.accessKeyId.trim().length === 0 || options.secretAccessKey.trim().length === 0) {
      throw new Error("s3_credentials_required");
    }
    this.endpoint = new URL(options.endpoint);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async put(artifact: ObjectStorageArtifact): Promise<{ objectKey: string; bytes: number }> {
    validateObjectKey(artifact.objectKey);
    const payloadHash = sha256Hex(artifact.bytes);
    const metadataHeaders = metadataToHeaders(artifact.metadata);
    const response = await this.signedFetch({
      method: "PUT",
      objectKey: artifact.objectKey,
      payloadHash,
      body: artifact.bytes,
      headers: {
        "content-type": artifact.contentType,
        ...metadataHeaders
      }
    });
    if (!response.ok) {
      throw new Error(`s3_put_failed:${response.status}`);
    }
    return { objectKey: artifact.objectKey, bytes: artifact.bytes.byteLength };
  }

  async get(objectKey: string): Promise<ObjectStorageArtifact | null> {
    validateObjectKey(objectKey);
    const response = await this.signedFetch({
      method: "GET",
      objectKey,
      payloadHash: sha256Hex(new Uint8Array()),
      headers: {}
    });
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`s3_get_failed:${response.status}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
      objectKey,
      bytes,
      contentType: headerValue(response.headers, "content-type") ?? "application/octet-stream",
      metadata: headersToMetadata(response.headers)
    };
  }

  async delete(objectKey: string): Promise<{ objectKey: string; deleted: boolean }> {
    validateObjectKey(objectKey);
    const response = await this.signedFetch({
      method: "DELETE",
      objectKey,
      payloadHash: sha256Hex(new Uint8Array()),
      headers: {}
    });
    if (response.status === 404) {
      return { objectKey, deleted: false };
    }
    if (!response.ok) {
      throw new Error(`s3_delete_failed:${response.status}`);
    }
    return { objectKey, deleted: true };
  }

  private async signedFetch(input: {
    method: "DELETE" | "GET" | "PUT";
    objectKey: string;
    payloadHash: string;
    headers: Record<string, string>;
    body?: Uint8Array;
  }): Promise<Response> {
    const signed = signS3Request({
      method: input.method,
      url: this.objectUrl(input.objectKey),
      headers: input.headers,
      payloadHash: input.payloadHash,
      region: this.options.region,
      accessKeyId: this.options.accessKeyId,
      secretAccessKey: this.options.secretAccessKey,
      now: this.now()
    });
    return this.fetchImpl(signed.url, {
      method: input.method,
      headers: signed.headers,
      ...(input.body ? { body: input.body } : {})
    });
  }

  private objectUrl(objectKey: string): URL {
    const basePath = this.endpoint.pathname.endsWith("/") ? this.endpoint.pathname.slice(0, -1) : this.endpoint.pathname;
    const url = new URL(this.endpoint.toString());
    url.pathname = `${basePath}/${encodePathSegment(this.options.bucket)}/${encodeObjectKey(objectKey)}`;
    url.search = "";
    return url;
  }
}

async function readMetadataFile(path: string): Promise<{ contentType: string; metadata: Record<string, string> }> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isObjectStorageMetadata(parsed)) {
      throw new Error("invalid_object_metadata");
    }
    return parsed;
  } catch (error) {
    if (isMissingFileError(error)) {
      return { contentType: "application/octet-stream", metadata: {} };
    }
    throw error;
  }
}

function validateObjectKey(objectKey: string): void {
  if (
    objectKey.trim().length === 0 ||
    objectKey.includes("\0") ||
    objectKey.startsWith("/") ||
    objectKey.split("/").some((segment) => segment === "..")
  ) {
    throw new Error("invalid_object_key");
  }
}

function metadataPath(objectPath: string): string {
  return `${objectPath}.metadata.json`;
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isObjectStorageMetadata(value: unknown): value is { contentType: string; metadata: Record<string, string> } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "contentType" in value &&
    typeof value.contentType === "string" &&
    "metadata" in value &&
    isStringRecord(value.metadata)
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

function signS3Request(input: {
  method: "DELETE" | "GET" | "PUT";
  url: URL;
  headers: Record<string, string>;
  payloadHash: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  now: Date;
}): { url: string; headers: Record<string, string> } {
  const amzDate = toAmzDate(input.now);
  const dateStamp = amzDate.slice(0, 8);
  const headers = normalizeHeaders({
    ...input.headers,
    host: input.url.host,
    "x-amz-content-sha256": input.payloadHash,
    "x-amz-date": amzDate
  });
  const signedHeaders = Object.keys(headers).sort();
  const credentialScope = `${dateStamp}/${input.region}/s3/aws4_request`;
  const canonicalRequest = [
    input.method,
    input.url.pathname,
    "",
    signedHeaders.map((header) => `${header}:${headers[header]}`).join("\n") + "\n",
    signedHeaders.join(";"),
    input.payloadHash
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest)
  ].join("\n");
  const signature = hmacHex(
    hmacBuffer(hmacBuffer(hmacBuffer(hmacBuffer(Buffer.from(`AWS4${input.secretAccessKey}`, "utf8"), dateStamp), input.region), "s3"), "aws4_request"),
    stringToSign
  );
  return {
    url: input.url.toString(),
    headers: {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders.join(";")}, Signature=${signature}`
    }
  };
}

function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers)
      .map(([key, value]) => [key.toLowerCase(), value.trim().replace(/\s+/g, " ")] as const)
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

function metadataToHeaders(metadata: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [`x-amz-meta-${safeMetadataKey(key)}`, value])
  );
}

function headersToMetadata(headers: Headers): Record<string, string> {
  const metadata: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (key.toLowerCase().startsWith("x-amz-meta-")) {
      metadata[key.slice("x-amz-meta-".length)] = value;
    }
  });
  return metadata;
}

function safeMetadataKey(key: string): string {
  const normalized = key.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  if (normalized.length === 0) {
    throw new Error("invalid_metadata_key");
  }
  return normalized;
}

function headerValue(headers: Headers, key: string): string | null {
  return headers.get(key);
}

function encodeObjectKey(objectKey: string): string {
  return objectKey.split("/").map(encodePathSegment).join("/");
}

function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function toAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function sha256Hex(input: Uint8Array | string): string {
  return createHash("sha256").update(input).digest("hex");
}

function hmacBuffer(key: Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function hmacHex(key: Buffer, value: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}
