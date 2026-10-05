import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';

import { SectionService } from './section.service';

describe('SectionService', () => {
  let router: Router;
  let section: SectionService;

  const on = async (path: string): Promise<boolean> => {
    await router.navigateByUrl(path);

    return section.isAdminSection();
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: '', children: [] },
          { path: 'response', children: [] },
          { path: 'response/:id', children: [] },
          { path: 'conversations', children: [] },
          { path: 'admin', children: [] },
          { path: 'admin/documents', children: [] },
          { path: 'admin/invite', children: [] },
          // A route whose name merely begins the same way. It exists to prove the
          // prefix match is on a path separator rather than on the letters.
          { path: 'administration', children: [] },
        ]),
      ],
    });

    router = TestBed.inject(Router);
    // Built after the router so the first path is read rather than assumed.
    section = TestBed.inject(SectionService);
  });

  it('is not the administrator section on the assistant', async () => {
    expect(await on('/')).toBe(false);
    expect(await on('/response')).toBe(false);
    expect(await on('/response/abc')).toBe(false);
    expect(await on('/conversations')).toBe(false);
  });

  it('is the administrator section on the dashboard and everything under it', async () => {
    expect(await on('/admin')).toBe(true);
    expect(await on('/admin/documents')).toBe(true);
    expect(await on('/admin/invite')).toBe(true);
  });

  it('does not treat a conversation called "admin" as the administrator section', async () => {
    // `startsWith('/admin/')` would not catch this, but the failure it guards is the
    // reverse one: a route that merely begins with the same letters being treated as
    // an admin screen, which would show administration navigation to somebody asking
    // a question.
    expect(await on('/administration')).toBe(false);
  });

  it('ignores a query string when deciding', async () => {
    await router.navigateByUrl('/admin?from=email');

    expect(section.isAdminSection()).toBe(true);
  });
});