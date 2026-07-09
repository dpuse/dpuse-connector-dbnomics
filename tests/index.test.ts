import { describe, expect, it } from 'vitest';
import { Connector } from '@/index';

describe('Connector', () => {
    it('constructs with the static config and no active operation', () => {
        const connector = new Connector({} as never, []);
        expect(connector.config.id).toBe('dpuse-connector-template');
        expect(connector.abortController).toBeUndefined();
    });

    it('abortOperation is a no-op when nothing is running', () => {
        const connector = new Connector({} as never, []);
        expect(() => connector.abortOperation()).not.toThrow();
        expect(connector.abortController).toBeUndefined();
    });
});
