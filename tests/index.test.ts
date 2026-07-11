import { afterEach, describe, expect, it, vi } from 'vitest';
import { Connector } from '@/index';
import type { ConnectorUtilities, ListNodesOptions, PreviewObjectOptions } from '@dpuse/dpuse-shared/component/module/connector';

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const PROXY_URL = 'https://api.dpuse.app/proxy';

function buildFetchResponse(body: unknown, ok = true): Response {
    return { ok, status: ok ? 200 : 500, json: () => Promise.resolve(body) } as unknown as Response;
}

// The connector's fetches go through dpuse-api's /proxy route (POST {method, url}) rather than hitting DBnomics
// directly, so assertions check the proxied call shape instead of a direct GET to the target URL.
function expectProxiedFetch(fetchMock: ReturnType<typeof vi.fn>, url: string): void {
    expect(fetchMock).toHaveBeenCalledWith(PROXY_URL, expect.objectContaining({ method: 'POST', body: JSON.stringify({ method: 'GET', url }) }));
}

// Minimal ConnectorUtilities stub — previewObject calls inferDataTypes; the other two methods aren't exercised here.
function buildConnectorUtilities(): ConnectorUtilities {
    return {
        hasReadableStreamTransferSupport: () => false,
        inferValues: () => ({}) as never,
        inferDataTypes: (parsedRecords) => ({ columnConfigs: [], hasHeaderRow: true, typedRecords: [] as never[] })
    };
}

// ── Tests ────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('Connector', () => {
    it('constructs with the static config and no active operation', () => {
        const connector = new Connector({} as never, []);
        expect(connector.config.id).toBe('dpuse-connector-dbnomics');
        expect(connector.abortController).toBeUndefined();
    });

    it('abortOperation is a no-op when nothing is running', () => {
        const connector = new Connector({} as never, []);
        expect(() => connector.abortOperation()).not.toThrow();
        expect(connector.abortController).toBeUndefined();
    });

    describe('listNodes', () => {
        afterEach(() => {
            vi.unstubAllGlobals();
        });

        it('lists providers at the root path', async () => {
            const fetchMock = vi
                .fn()
                .mockResolvedValue(
                    buildFetchResponse({ providers: { docs: [{ code: 'IMF', name: 'International Monetary Fund' }], limit: 100, offset: 0, num_found: 1 } })
                );
            vi.stubGlobal('fetch', fetchMock);

            const connector = new Connector({} as never, []);
            const result = await connector.listNodes({ folderPath: '' } as ListNodesOptions);

            expectProxiedFetch(fetchMock, 'https://api.db.nomics.world/v22/providers?limit=100&offset=0');
            expect(result.connectionNodeConfigs).toEqual([
                expect.objectContaining({ id: 'IMF', name: 'IMF', label: 'International Monetary Fund', typeId: 'folder', folderPath: '' })
            ]);
            expect(result.isMore).toBe(false);
            expect(result.cursor).toBeUndefined();
            expect(result.totalCount).toBe(1);
        });

        it('lists datasets for a provider path', async () => {
            const fetchMock = vi
                .fn()
                .mockResolvedValue(
                    buildFetchResponse({ datasets: { docs: [{ code: 'AFRREO', name: 'Sub-Saharan Africa', nb_series: 1654 }], limit: 100, offset: 0, num_found: 1 } })
                );
            vi.stubGlobal('fetch', fetchMock);

            const connector = new Connector({} as never, []);
            const result = await connector.listNodes({ folderPath: '/IMF' } as ListNodesOptions);

            expectProxiedFetch(fetchMock, 'https://api.db.nomics.world/v22/datasets/IMF?limit=100&offset=0');
            expect(result.connectionNodeConfigs).toEqual([
                expect.objectContaining({ id: 'AFRREO', childCount: 1654, typeId: 'folder', folderPath: '/IMF' })
            ]);
        });

        it('lists a single page of series for a dataset path, honoring limit/offset without looping', async () => {
            const fetchMock = vi
                .fn()
                .mockResolvedValue(
                    buildFetchResponse({ series: { docs: [{ series_code: 'A.NGDP', series_name: 'GDP, current prices' }], limit: 50, offset: 50, num_found: 1654 } })
                );
            vi.stubGlobal('fetch', fetchMock);

            const connector = new Connector({} as never, []);
            const result = await connector.listNodes({ folderPath: '/IMF/AFRREO', limit: 50, offset: 50 } as ListNodesOptions);

            expect(fetchMock).toHaveBeenCalledTimes(1);
            expectProxiedFetch(fetchMock, 'https://api.db.nomics.world/v22/series/IMF/AFRREO?limit=50&offset=50');
            expect(result.connectionNodeConfigs).toEqual([expect.objectContaining({ id: 'A.NGDP', typeId: 'object', folderPath: '/IMF/AFRREO' })]);
            expect(result.isMore).toBe(true);
            expect(result.cursor).toBe(51);
            expect(result.totalCount).toBe(1654);
        });

        it('rejects an invalid folder path', async () => {
            const connector = new Connector({} as never, []);
            await expect(connector.listNodes({ folderPath: '/a/b/c' } as ListNodesOptions)).rejects.toThrow(/invalid folder path/i);
        });

        it('surfaces a non-OK DBnomics response as an error', async () => {
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue(buildFetchResponse({}, false)));
            const connector = new Connector({} as never, []);
            await expect(connector.listNodes({ folderPath: '' } as ListNodesOptions)).rejects.toThrow(/failed with status 500/);
        });

        it('serves a repeated request from the instance cache without re-fetching', async () => {
            const fetchMock = vi.fn().mockResolvedValue(buildFetchResponse({ providers: { docs: [], limit: 100, offset: 0, num_found: 0 } }));
            vi.stubGlobal('fetch', fetchMock);

            const connector = new Connector({} as never, []);
            await connector.listNodes({ folderPath: '' } as ListNodesOptions);
            await connector.listNodes({ folderPath: '' } as ListNodesOptions);

            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it('evicts the oldest cache entry once the cache exceeds its entry cap', async () => {
            const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(buildFetchResponse({ providers: { docs: [], limit: 1, offset: 0, num_found: 0 } })));
            vi.stubGlobal('fetch', fetchMock);

            const connector = new Connector({} as never, []);
            // Fill the cache past its entry cap (200) with distinct pages, then re-request the first (now-evicted) page.
            for (let offset = 0; offset <= 200; offset++) {
                await connector.listNodes({ folderPath: '', limit: 1, offset } as ListNodesOptions);
            }
            const callCountBeforeReRequest = fetchMock.mock.calls.length;

            await connector.listNodes({ folderPath: '', limit: 1, offset: 0 } as ListNodesOptions); // Evicted -> re-fetches.
            await connector.listNodes({ folderPath: '', limit: 1, offset: 200 } as ListNodesOptions); // Still cached -> no re-fetch.

            expect(fetchMock.mock.calls.length).toBe(callCountBeforeReRequest + 1);
        });
    });

    describe('previewObject', () => {
        afterEach(() => {
            vi.unstubAllGlobals();
        });

        it('previews a series as header + observation rows', async () => {
            const fetchMock = vi.fn().mockResolvedValue(
                buildFetchResponse({
                    series: { docs: [{ series_code: 'A.NGDP', series_name: 'GDP', period: ['2000', '2001', '2002'], value: [1.1, 2.2, null] }], num_found: 1 }
                })
            );
            vi.stubGlobal('fetch', fetchMock);

            const connector = new Connector(buildConnectorUtilities(), []);
            const result = await connector.previewObject({ path: '/IMF/AFRREO/A.NGDP' } as PreviewObjectOptions);

            expectProxiedFetch(fetchMock, 'https://api.db.nomics.world/v22/series/IMF/AFRREO/A.NGDP?observations=1');
            expect(result.dataFormatId).toBe('json');
            expect(result.parsedRecords).toEqual([
                [
                    { value: 'period', valueWasQuoted: false },
                    { value: 'value', valueWasQuoted: false }
                ],
                [
                    { value: '2000', valueWasQuoted: false },
                    { value: '1.1', valueWasQuoted: false }
                ],
                [
                    { value: '2001', valueWasQuoted: false },
                    { value: '2.2', valueWasQuoted: false }
                ],
                [
                    { value: '2002', valueWasQuoted: false },
                    { value: null, valueWasQuoted: false }
                ]
            ]);
        });

        it('truncates to the preview row limit for a large series', async () => {
            const periods = Array.from({ length: 60 }, (_, index) => String(2000 + index));
            const values = Array.from({ length: 60 }, (_, index) => index);
            const fetchMock = vi
                .fn()
                .mockResolvedValue(buildFetchResponse({ series: { docs: [{ series_code: 'A.NGDP', series_name: 'GDP', period: periods, value: values }], num_found: 1 } }));
            vi.stubGlobal('fetch', fetchMock);

            const connector = new Connector(buildConnectorUtilities(), []);
            const result = await connector.previewObject({ path: '/IMF/AFRREO/A.NGDP' } as PreviewObjectOptions);

            expect(result.parsedRecords).toHaveLength(51); // 1 header row + 50 data rows, not all 60 observations.
        });

        it('rejects an invalid object path', async () => {
            const connector = new Connector(buildConnectorUtilities(), []);
            await expect(connector.previewObject({ path: '/IMF/AFRREO' } as PreviewObjectOptions)).rejects.toThrow(/invalid object path/i);
        });

        it('rejects when the series is not found', async () => {
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue(buildFetchResponse({ series: { docs: [], num_found: 0 } })));
            const connector = new Connector(buildConnectorUtilities(), []);
            await expect(connector.previewObject({ path: '/IMF/AFRREO/UNKNOWN' } as PreviewObjectOptions)).rejects.toThrow(/not found/i);
        });
    });
});
