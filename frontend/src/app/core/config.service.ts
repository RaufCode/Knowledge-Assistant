import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export interface AppConfig {
  apiBaseUrl: string;
}

const DEFAULT_API_BASE_URL = 'http://localhost:8099';

@Injectable({ providedIn: 'root' })
export class ConfigService {
  private readonly http = inject(HttpClient);
  private config: AppConfig | null = null;

  async load(): Promise<void> {
    try {
      this.config = await firstValueFrom(
        this.http.get<AppConfig>('/config.json'),
      );
    } catch {
      // Served without config.json (or offline): fall back to the default
      // rather than rejecting the APP_INITIALIZER, which would stop the app
      // from booting at all.
      this.config = null;
    }
  }

  getApiBaseUrl(): string {
    if (!this.config) {
      return DEFAULT_API_BASE_URL;
    }
    return this.config.apiBaseUrl;
  }
}

export const loadConfig = (configService: ConfigService) => () => configService.load();