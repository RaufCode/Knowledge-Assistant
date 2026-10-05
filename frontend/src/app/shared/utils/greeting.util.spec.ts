import { greetingReply, isGreeting } from './greeting.util';

describe('isGreeting', () => {
  it.each([
    'hello',
    'Hello!',
    '  HI  ',
    'hey',
    'heyyy?',
    'good morning',
    'Good MORNING...',
    'hello there',
    'hey team',
    'how are you?',
    "what's up",
    'hello assistant',
  ])('treats %j as small talk', (text) => {
    expect(isGreeting(text)).toBe(true);
  });

  it.each([
    '',
    '   ',
    'hello, what is the leave policy?',
    'hi, how many leave days do I get?',
    'morning shift allowance?',
    'history',
    'help',
    'hey you',
    'good morning team, please approve my leave',
    'a'.repeat(100),
  ])('sends %j to the backend', (text) => {
    expect(isGreeting(text)).toBe(false);
  });
});

describe('greetingReply', () => {
  it('names the time of day and what to ask about', () => {
    const reply = greetingReply(new Date(2026, 0, 1, 9));

    expect(reply).toContain('Good morning');
    expect(reply).toContain('leave');
  });

  it('greets for the evening after hours', () => {
    expect(greetingReply(new Date(2026, 0, 1, 20))).toContain('Good evening');
  });
});
