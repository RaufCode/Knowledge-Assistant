import { markdownToHtml, markdownToSnippetHtml } from './markdown.util';

describe('markdownToSnippetHtml', () => {
  it('strips heading markers but keeps the heading text', () => {
    expect(markdownToSnippetHtml('## Annual (vacation) leave')).toBe(
      '<strong>Annual (vacation) leave</strong>',
    );
  });

  it('strips bullet markers and keeps emphasis', () => {
    expect(markdownToSnippetHtml('* **Phone:** +233 30 000 0000')).toBe(
      '<strong>Phone:</strong> +233 30 000 0000',
    );
  });

  it('flattens a table row into joined cells', () => {
    expect(
      markdownToSnippetHtml('| Topic | Contact |\n|-------|---------|\n| Leave | HR portal |'),
    ).toBe('<strong>Topic</strong> · <strong>Contact</strong> Leave · HR portal');
  });

  it('emits no block elements, so nothing breaks out of the citation card', () => {
    const html = markdownToSnippetHtml('## Who to contact\n\n- Leave, payslips\n- Salary');
    expect(html).not.toMatch(/<\/?(ul|ol|li|p|h[1-6]|table)/);
  });

  it('emits no leftover heading or emphasis markers', () => {
    const html = markdownToSnippetHtml('## Overview\n**Effective date:** 1 January 2026');
    expect(html).not.toContain('##');
    expect(html).not.toContain('**');
  });

  it('collapses the line breaks a policy page arrives with', () => {
    expect(markdownToSnippetHtml('One\n\ntwo\n\nthree')).toBe('One two three');
  });

  it('escapes HTML in a snippet', () => {
    expect(markdownToSnippetHtml('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
  });

  it('renders the snippet the backend returns for the leave policy', () => {
    const snippet =
      '## Annual (vacation) leave\n\nFull-time employees are entitled to **21 working days** ' +
      'of paid annual leave per calendar year.';

    expect(markdownToSnippetHtml(snippet)).toBe(
      '<strong>Annual (vacation) leave</strong> Full-time employees are entitled to ' +
        '<strong>21 working days</strong> of paid annual leave per calendar year.',
    );
  });
});

describe('markdownToHtml', () => {
  it('renders bold without leaking the asterisks', () => {
    expect(markdownToHtml('**Phone:** +233 30 000 0000')).toBe(
      '<p><strong>Phone:</strong> +233 30 000 0000</p>',
    );
  });

  it('renders bullet lists', () => {
    expect(markdownToHtml('* **Phone:** 123\n* **Email:** hr@acme.example')).toBe(
      '<ul><li><strong>Phone:</strong> 123</li><li><strong>Email:</strong> hr@acme.example</li></ul>',
    );
  });

  it('renders numbered steps', () => {
    expect(markdownToHtml('1. **Install the client.**\n2. Sign in.')).toBe(
      '<ol><li><strong>Install the client.</strong></li><li>Sign in.</li></ol>',
    );
  });

  it('renders headings', () => {
    expect(markdownToHtml('## Annual leave\nFull-time staff accrue 21 days.')).toBe(
      '<h2>Annual leave</h2><p>Full-time staff accrue 21 days.</p>',
    );
  });

  it('renders tables with a header row', () => {
    expect(markdownToHtml('| Topic | Contact |\n|---|---|\n| Leave | HR portal |')).toBe(
      '<table><thead><tr><th>Topic</th><th>Contact</th></tr></thead>' +
        '<tbody><tr><td>Leave</td><td>HR portal</td></tr></tbody></table>',
    );
  });

  it('rejoins wrapped paragraph lines', () => {
    expect(markdownToHtml('Contact HR through\nthe channels below.')).toBe(
      '<p>Contact HR through the channels below.</p>',
    );
  });

  it('escapes HTML in the source so it cannot inject markup', () => {
    expect(markdownToHtml('<script>alert(1)</script>')).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
    );
  });

  it('escapes HTML inside an emphasised span', () => {
    expect(markdownToHtml('**<img src=x>**')).toBe('<p><strong>&lt;img src=x&gt;</strong></p>');
  });

  it('leaves emphasis markers alone inside a code span', () => {
    expect(markdownToHtml('use `**literal**` here')).toBe(
      '<p>use <code>**literal**</code> here</p>',
    );
  });

  it('returns nothing for empty or whitespace-only text', () => {
    expect(markdownToHtml('')).toBe('');
    expect(markdownToHtml('   \n  \n')).toBe('');
  });

  it('renders the shape the backend actually returns for an HR answer', () => {
    const answer =
      'You can contact People & Culture (HR) through the following channels:\n\n' +
      '* **Phone:** +233 30 000 0000\n' +
      '* **Email:** hr@acmetech.example\n' +
      '* **Self-service portal:** Available on the intranet';

    expect(markdownToHtml(answer)).toBe(
      '<p>You can contact People &amp; Culture (HR) through the following channels:</p>' +
        '<ul>' +
        '<li><strong>Phone:</strong> +233 30 000 0000</li>' +
        '<li><strong>Email:</strong> hr@acmetech.example</li>' +
        '<li><strong>Self-service portal:</strong> Available on the intranet</li>' +
        '</ul>',
    );
  });
});
