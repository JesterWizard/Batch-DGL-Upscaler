import Dexie, { type Table } from 'dexie';

export interface ImageRecord {
  id?: number;
  originalName: string;
  originalUrl: string;
  upscaledUrl?: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  error?: string;
  createdAt: number;
  completedAt?: number;
}

export class NanoBananaDB extends Dexie {
  images!: Table<ImageRecord>;

  constructor() {
    super('NanoBananaDB');
    this.version(1).stores({
      images: '++id, status, createdAt'
    });
  }
}

export const db = new NanoBananaDB();
