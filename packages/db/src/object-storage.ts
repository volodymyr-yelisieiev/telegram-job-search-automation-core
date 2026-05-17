export interface ObjectStorageArtifact {
  objectKey: string;
  bytes: Uint8Array;
  contentType: string;
  metadata: Record<string, string>;
}

export interface ObjectStorageAdapter {
  put(artifact: ObjectStorageArtifact): Promise<{ objectKey: string; bytes: number }>;
  get(objectKey: string): Promise<ObjectStorageArtifact | null>;
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
}
