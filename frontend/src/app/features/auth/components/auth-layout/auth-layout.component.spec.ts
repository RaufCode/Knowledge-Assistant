import { ComponentFixture, TestBed } from '@angular/core/testing';

import { AuthLayoutComponent } from './auth-layout.component';

describe('AuthLayoutComponent', () => {
  let fixture: ComponentFixture<AuthLayoutComponent>;

  const text = (): string => (fixture.nativeElement as HTMLElement).textContent ?? '';

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [AuthLayoutComponent] }).compileComponents();

    fixture = TestBed.createComponent(AuthLayoutComponent);
    fixture.detectChanges();
  });

  it('names the product, which is the only identity on a signed-out screen', () => {
    expect(text()).toContain('Internal Knowledge');
    expect(text()).toContain('Assistant');
  });

  it('sets the name larger and heavier, because nothing else on the screen competes', () => {
    const name = (fixture.nativeElement as HTMLElement).querySelector(
      'app-brand-logo span',
    ) as HTMLElement;

    // The sidebar's compact line is `text-sm font-semibold`; standing alone it is
    // `text-xl font-bold`. Asserted on the classes rather than on a pixel because
    // that is what is actually being decided here.
    expect(name.className).toContain('text-xl');
    expect(name.className).toContain('font-bold');
    expect(name.className).toContain('text-primary');
  });

  it('says nothing about how accounts are made or where the session is kept', () => {
    // Both notes are gone: they were true, and neither is the reader's problem at
    // the moment they are trying to sign in. One of them also named a company this
    // product is not for.
    expect(text()).not.toContain('created by invitation');
    expect(text()).not.toContain('secure cookie');
    expect(text()).not.toContain('AmaliTech');
  });

  it('leaves out the internal-system notice the designs put on every signed-out screen', () => {
    // It contradicted the registration link sitting above it, and it has been
    // taken off the shared layout rather than left to differ per screen.
    expect(text()).not.toContain('Protected internal system - SSO enabled');
  });

  it('leaves out the claim that nothing typed here is sent anywhere', () => {
    // It was true only while the signed-out screens discarded their input. Now they
    // post to the backend, so a password typed into a form that says it is sent
    // nowhere would be a lie told to the reader.
    expect(text()).not.toContain('nothing you enter is sent anywhere');
    expect(text()).not.toContain('Design preview');
  });
});
