import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { API_BASE_URL } from '../../core/api.config';
import { AuthService } from '../../core/services/auth.service';
import { DashboardViewComponent } from './dashboard-view.component';

describe('DashboardViewComponent', () => {
  let fixture: ComponentFixture<DashboardViewComponent>;

  const element = (): HTMLElement => fixture.nativeElement as HTMLElement;

  const signInAs = async (name: string): Promise<void> => {
    const bootstrap = TestBed.inject(AuthService).bootstrap();

    TestBed.inject(HttpTestingController)
      .expectOne(`${API_BASE_URL}/api/auth/me`)
      .flush({ id: 'u1', name, email: 'ama@acmetech.example', role: 'employee' });
    await bootstrap;
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [DashboardViewComponent],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();

    fixture = TestBed.createComponent(DashboardViewComponent);
  });

  it('greets by first name, not the whole one', async () => {
    await signInAs('Ama Konadu');

    // The first thing on the screen, and the only greeting in the app.
    expect(element().textContent).toContain('Ama');
    expect(element().textContent).not.toContain('Konadu');
  });

  it('says something before the name is known, rather than nothing', async () => {
    fixture.detectChanges();
    await fixture.whenStable();

    // While the session resolves there is no name to use, and a heading with a hole
    // where one should be would be worse than a greeting without it. So a greeting is
    // still there — it just does not name anybody.
    const heading = element().querySelector('h2')?.textContent?.trim() ?? '';

    expect(heading.length).toBeGreaterThan(0);
    expect(heading).not.toContain(',');
  });

  it('greets differently from one visit to the next', () => {
    const greets: string[] = [];

    for (let attempt = 0; attempt < 40; attempt += 1) {
      const one = TestBed.createComponent(DashboardViewComponent);

      one.detectChanges();
      greets.push(one.nativeElement.querySelector('h2')?.textContent?.trim() ?? '');
      one.destroy();
    }

    // Four greetings exist and one is picked per visit, so forty visits between them
    // is more than enough to show the heading is not a single fixed sentence. A fixed
    // one would make this set size 1.
    expect(new Set(greets).size).toBeGreaterThan(1);
  });

  it('settles on one greeting for the length of a visit', async () => {
    await signInAs('Ama Konadu');

    const heading = () => element().querySelector('h2')?.textContent?.trim();
    const first = heading();

    // A greeting that rewrote itself under the reader would read as a glitch, so it is
    // chosen once and then left alone.
    element().querySelector('app-question-input')?.dispatchEvent(new Event('focus'));
    fixture.detectChanges();
    await fixture.whenStable();

    expect(heading()).toBe(first);
  });
});
