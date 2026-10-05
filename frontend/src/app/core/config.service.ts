import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export interface AppConfig {
  apiBaseUrl: string;
}

/**
 * Empty, so the app calls the API on its own origin and the session cookies are
 * first-party. See `api.config.ts` for why that is the only arrangement that
 * works the same way on a phone, a laptop and every browser.
 *
 * Kept in step with `API_BASE_URL` deliberately rather than referring to it: this
 * module runs before any injection context exists, and the constant is the
 * documented default for the whole app.
 */
const DEFAULT_API_BASE_URL = '';

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