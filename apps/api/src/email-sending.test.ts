import { describe, expect, it } from 'vitest';
import { renderTemplate, templateVariables, validateTemplateVariables, withRequiredFooter } from './email-templates.js';
import { createMimeMessage, decryptCredential, encryptCredential } from './gmail.js';

describe('email template rendering', () => {
  it('renders only the approved recipient fields', () => {
    expect(templateVariables('Hi {{ name }} from {{username}}')).toEqual(['name', 'username']);
    expect(renderTemplate('Hi {{name}} <{{email}}>', { name: 'Ada', email: 'ada@example.com' })).toBe('Hi Ada <ada@example.com>');
    expect(() => validateTemplateVariables('Hello {{company}}', 'Body')).toThrow('Unknown merge fields: company');
  });

  it('adds sender identification and the manual opt-out instruction', () => {
    expect(withRequiredFooter('Hello', 'Richard Wang')).toBe('Hello\n\n--\nRichard Wang\nTo opt out of future emails, reply with "unsubscribe".');
  });
});

describe('Gmail credential protection', () => {
  const key = Buffer.alloc(32, 7).toString('base64');

  it('round-trips a refresh token with authenticated encryption', () => {
    const encrypted = encryptCredential('refresh-token-value', key);
    expect(encrypted).not.toContain('refresh-token-value');
    expect(decryptCredential(encrypted, key)).toBe('refresh-token-value');
  });

  it('rejects malformed encryption keys', () => {
    expect(() => encryptCredential('secret', Buffer.alloc(12).toString('base64'))).toThrow('32-byte key');
  });
});

describe('plain-text MIME creation', () => {
  it('uses the deterministic recipient task ID as the Message-ID', () => {
    const message = createMimeMessage({
      from: 'sender@example.com', to: 'recipient@example.com', senderName: 'Richard Wang',
      subject: 'Hello', bodyText: 'Line one\nLine two', messageId: 'recipient-task-id'
    });
    expect(message).toContain('Message-ID: <recipient-task-id@email-fetch.local>');
    expect(message).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(message).toContain('Line one\r\nLine two');
  });
});
