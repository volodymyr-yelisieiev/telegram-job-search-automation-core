import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SecretReference } from "@job-search/domain";

type SecretPurpose = SecretReference["purpose"];

interface LocalSecretEnvelope {
  id: string;
  providerId: string;
  purpose: SecretPurpose;
  backend: "local_encrypted_file";
  reference: string;
  createdAt: string;
  rotatedAt: string | null;
  expiresAt: string | null;
  iv: string;
  tag: string;
  ciphertext: string;
}

interface LocalSecretFile {
  schemaVersion: "local-encrypted-file-secret-store/v1";
  secrets: LocalSecretEnvelope[];
}

export interface LocalEncryptedFileSecretStoreOptions {
  rootDir: string;
  masterKey: string;
  fileName?: string;
}

export interface SecretStoreProbe {
  backend: "local_encrypted_file";
  accessible: boolean;
  checkedAt: string;
  referenceCount: number;
}

export class LocalEncryptedFileSecretStore {
  private readonly filePath: string;
  private readonly key: Buffer;

  constructor(private readonly options: LocalEncryptedFileSecretStoreOptions) {
    if (options.masterKey.trim().length < 16) {
      throw new Error("Local encrypted secret store masterKey must be at least 16 characters");
    }
    this.filePath = join(options.rootDir, options.fileName ?? "secrets.json");
    this.key = createHash("sha256").update(options.masterKey).digest();
  }

  async put(input: {
    providerId: string;
    purpose: SecretPurpose;
    plaintext: string;
    expiresAt?: string | null;
    now?: Date;
  }): Promise<SecretReference> {
    const now = (input.now ?? new Date()).toISOString();
    const id = `sec_${randomUUID()}`;
    const envelope = this.encrypt({
      id,
      providerId: input.providerId,
      purpose: input.purpose,
      plaintext: input.plaintext,
      createdAt: now,
      rotatedAt: now,
      expiresAt: input.expiresAt ?? null
    });
    const file = await this.readStore();
    file.secrets.push(envelope);
    await this.writeStore(file);
    return toReference(envelope);
  }

  async get(reference: SecretReference | string): Promise<string> {
    const id = secretId(reference);
    const envelope = (await this.readStore()).secrets.find((secret) => secret.id === id);
    if (!envelope) {
      throw new Error(`Secret reference not found: ${id}`);
    }
    return this.decrypt(envelope);
  }

  async rotate(input: {
    reference: SecretReference | string;
    plaintext: string;
    expiresAt?: string | null;
    now?: Date;
  }): Promise<SecretReference> {
    const id = secretId(input.reference);
    const file = await this.readStore();
    const index = file.secrets.findIndex((secret) => secret.id === id);
    if (index < 0) {
      throw new Error(`Secret reference not found: ${id}`);
    }
    const previous = file.secrets[index]!;
    const rotatedAt = (input.now ?? new Date()).toISOString();
    const next = this.encrypt({
      id,
      providerId: previous.providerId,
      purpose: previous.purpose,
      plaintext: input.plaintext,
      createdAt: previous.createdAt,
      rotatedAt,
      expiresAt: input.expiresAt ?? previous.expiresAt
    });
    file.secrets[index] = next;
    await this.writeStore(file);
    return toReference(next);
  }

  async delete(reference: SecretReference | string): Promise<void> {
    const id = secretId(reference);
    const file = await this.readStore();
    file.secrets = file.secrets.filter((secret) => secret.id !== id);
    await this.writeStore(file);
  }

  async listReferences(): Promise<SecretReference[]> {
    return (await this.readStore()).secrets.map(toReference);
  }

  async probe(now = new Date()): Promise<SecretStoreProbe> {
    const file = await this.readStore();
    for (const secret of file.secrets) {
      this.decrypt(secret);
    }
    return {
      backend: "local_encrypted_file",
      accessible: true,
      checkedAt: now.toISOString(),
      referenceCount: file.secrets.length
    };
  }

  private encrypt(input: {
    id: string;
    providerId: string;
    purpose: SecretPurpose;
    plaintext: string;
    createdAt: string;
    rotatedAt: string | null;
    expiresAt: string | null;
  }): LocalSecretEnvelope {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const aad = Buffer.from(`${input.id}:${input.providerId}:${input.purpose}`);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(input.plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      id: input.id,
      providerId: input.providerId,
      purpose: input.purpose,
      backend: "local_encrypted_file",
      reference: `local-encrypted-file://${input.id}`,
      createdAt: input.createdAt,
      rotatedAt: input.rotatedAt,
      expiresAt: input.expiresAt,
      iv: iv.toString("base64url"),
      tag: tag.toString("base64url"),
      ciphertext: ciphertext.toString("base64url")
    };
  }

  private decrypt(envelope: LocalSecretEnvelope): string {
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(envelope.iv, "base64url"));
    decipher.setAAD(Buffer.from(`${envelope.id}:${envelope.providerId}:${envelope.purpose}`));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64url")), decipher.final()]).toString("utf8");
  }

  private async readStore(): Promise<LocalSecretFile> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as LocalSecretFile;
      if (parsed.schemaVersion !== "local-encrypted-file-secret-store/v1" || !Array.isArray(parsed.secrets)) {
        throw new Error("Invalid local encrypted secret store file");
      }
      return parsed;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return { schemaVersion: "local-encrypted-file-secret-store/v1", secrets: [] };
      }
      throw error;
    }
  }

  private async writeStore(file: LocalSecretFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    await rename(tempPath, this.filePath);
  }
}

function toReference(envelope: LocalSecretEnvelope): SecretReference {
  return {
    id: envelope.id,
    providerId: envelope.providerId,
    purpose: envelope.purpose,
    backend: envelope.backend,
    reference: envelope.reference,
    createdAt: envelope.createdAt,
    rotatedAt: envelope.rotatedAt,
    expiresAt: envelope.expiresAt
  };
}

function secretId(reference: SecretReference | string): string {
  const value = typeof reference === "string" ? reference : reference.reference;
  return value.startsWith("local-encrypted-file://") ? value.slice("local-encrypted-file://".length) : value;
}
