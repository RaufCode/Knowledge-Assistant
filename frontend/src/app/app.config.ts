import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { ApplicationConfig, provideBrowserGlobalErrorListeners, APP_INITIALIZER } from '@angular/core';
import { provideClientHydration } from '@angular/platform-browser';
import { provideRouter, withComponentInputBinding, withInMemoryScrolling } from '@angular/router';

import { routes } from './app.routes';
import { authInterceptor } from './core/interceptors/auth.interceptor';
import { ConfigService, loadConfig } from './core/config.service';
import { AuthService } from './core/services/auth.service';

const initializeApp = (configService: ConfigService, authService: AuthService) => async () => {
  await loadConfig(configService)();
  await authService.maybeBootstrap();
};

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(
      routes,
      withComponentInputBinding(),
      withInMemoryScrolling({ scrollPositionRestoration: 'enabled' }),
    ),
    // `ApiService` is the only place allowed to use HttpClient, and it is the
    // only thing that knows the backend's URLs. Nothing here fetches on the
    // server: the conversation belongs to a browser session, and a server render
    // would pay the round trip on every request to paint what the client is about
    // to fetch anyway.
    //
    // The interceptor is registered here rather than inside `ApiService` because it
    // has to see every request, including any made by a service added later by
    // somebody who has not thought about auth at all.
    provideHttpClient(withInterceptors([authInterceptor])),
    provideClientHydration(),
    ConfigService,
    {
      provide: APP_INITIALIZER,
      useFactory: initializeApp,
      deps: [ConfigService, AuthService],
      multi: true,
    },
  ],
};
