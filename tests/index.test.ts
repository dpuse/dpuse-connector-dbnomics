import { afterEach, describe, expect, it, vi } from 'vitest';
import { Connector } from '@/index';
import type { ConnectorUtilities, GetInfoOptions, ListNodesOptions, PreviewObjectOptions } from '@dpuse/dpuse-shared/component/module/connector';

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

// Routes a proxied fetch to a fixture by the target URL it was asked to forward, so multi-call flows (e.g. fetch
// the category tree, then fetch series) can be tested against distinct responses per URL instead of one canned body.
function buildRoutedFetchMock(routes: Record<string, unknown>): ReturnType<typeof vi.fn> {
    return vi.fn().mockImplementation((_target: string, init: { body: string }) => {
        const { url } = JSON.parse(init.body) as { url: string };
        if (!(url in routes)) throw new Error(`Unexpected proxied fetch to '${url}'.`);
        return Promise.resolve(buildFetchResponse(routes[url]));
    });
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

        it('lists a provider’s top-level category_tree entries, merging series counts onto dataset leaves', async () => {
            const fetchMock = buildRoutedFetchMock({
                'https://api.db.nomics.world/v22/providers/IMF': {
                    category_tree: [
                        { code: 'CAT1', name: 'Category One', children: [{ code: 'DS1', name: 'Dataset One' }] },
                        { code: 'AFRREO', name: 'Sub-Saharan Africa' } // Leaf directly at the top level (seen live on ECB).
                    ]
                },
                'https://api.db.nomics.world/v22/datasets/IMF?limit=500&offset=0': {
                    datasets: { docs: [{ code: 'AFRREO', name: 'Sub-Saharan Africa', nb_series: 1654 }], limit: 500, offset: 0, num_found: 1 }
                }
            });
            vi.stubGlobal('fetch', fetchMock);

            const connector = new Connector({} as never, []);
            const result = await connector.listNodes({ folderPath: '/IMF' } as ListNodesOptions);

            expect(result.connectionNodeConfigs).toEqual([
                expect.objectContaining({ id: 'CAT1', childCount: 1, typeId: 'folder', folderPath: '/IMF' }), // Category -> immediate child count, free.
                expect.objectContaining({ id: 'AFRREO', childCount: 1654, typeId: 'folder', folderPath: '/IMF' }) // Dataset leaf -> merged nb_series.
            ]);
        });

        it('returns every child of a category level in one response, ignoring limit/offset, without an extra fetch when no children are dataset leaves', async () => {
            const fetchMock = buildRoutedFetchMock({
                'https://api.db.nomics.world/v22/providers/PROV': {
                    category_tree: [
                        { code: 'A', name: 'A', children: [{ code: 'X1', name: 'x1' }] },
                        { code: 'B', name: 'B', children: [{ code: 'X2', name: 'x2' }] },
                        { code: 'C', name: 'C', children: [{ code: 'X3', name: 'x3' }] }
                    ]
                }
            });
            vi.stubGlobal('fetch', fetchMock);

            const connector = new Connector({} as never, []);
            // limit/offset are supplied but must be ignored for a category level -- all 3 children come back regardless.
            const result = await connector.listNodes({ folderPath: '/PROV', limit: 2, offset: 1 } as ListNodesOptions);

            expect(fetchMock).toHaveBeenCalledTimes(1); // Only the tree fetch -- no per-page API call, no dataset-count merge needed.
            expect(result.connectionNodeConfigs).toEqual([
                expect.objectContaining({ id: 'A' }),
                expect.objectContaining({ id: 'B' }),
                expect.objectContaining({ id: 'C' })
            ]);
            expect(result.isMore).toBe(false);
            expect(result.cursor).toBeUndefined();
            expect(result.totalCount).toBe(3);
        });

        it('descends multiple category levels to a dataset leaf, then lists its series', async () => {
            const fetchMock = buildRoutedFetchMock({
                'https://api.db.nomics.world/v22/providers/INSEE': {
                    category_tree: [{ code: 'ECO', name: 'Economy', children: [{ code: 'GEN', name: 'General', children: [{ code: 'CNA-2010-PIB', name: 'GDP' }] }] }]
                },
                'https://api.db.nomics.world/v22/series/INSEE/CNA-2010-PIB?limit=100&offset=0': {
                    series: { docs: [{ series_code: 'A.FR.PIB', series_name: 'French GDP' }], limit: 100, offset: 0, num_found: 1 }
                }
            });
            vi.stubGlobal('fetch', fetchMock);

            const connector = new Connector({} as never, []);
            const result = await connector.listNodes({ folderPath: '/INSEE/ECO/GEN/CNA-2010-PIB' } as ListNodesOptions);

            expect(result.connectionNodeConfigs).toEqual([expect.objectContaining({ id: 'A.FR.PIB', typeId: 'object', folderPath: '/INSEE/ECO/GEN/CNA-2010-PIB' })]);
        });

        it('falls back to the category name as its path segment when a provider omits category codes (e.g. Bank of Indonesia, ECB)', async () => {
            const fetchMock = buildRoutedFetchMock({
                'https://api.db.nomics.world/v22/providers/BI': {
                    category_tree: [{ code: null, name: 'MONEY AND BANKING', children: [{ code: 'DS1', name: 'Dataset One' }] }]
                },
                'https://api.db.nomics.world/v22/datasets/BI?limit=500&offset=0': {
                    datasets: { docs: [{ code: 'DS1', name: 'Dataset One', nb_series: 12 }], limit: 500, offset: 0, num_found: 1 }
                }
            });
            vi.stubGlobal('fetch', fetchMock);

            const connector = new Connector({} as never, []);
            const topLevel = await connector.listNodes({ folderPath: '/BI' } as ListNodesOptions);

            // The category's id must be its name (not null / the string "null"), since that's what the app will use
            // to build the next folderPath when the user drills in.
            const category = topLevel.connectionNodeConfigs[0];
            expect(category).toEqual(expect.objectContaining({ id: 'MONEY AND BANKING', typeId: 'folder' }));

            // Drilling into that folder path must resolve back to the same category, not throw "invalid folder path".
            const nextLevel = await connector.listNodes({ folderPath: `/BI/${category?.id}` } as ListNodesOptions);
            expect(nextLevel.connectionNodeConfigs).toEqual([expect.objectContaining({ id: 'DS1', childCount: 12, typeId: 'folder' })]);
        });

        it('falls back to the flat dataset list when category_tree is empty', async () => {
            const fetchMock = buildRoutedFetchMock({
                'https://api.db.nomics.world/v22/providers/IMF': { category_tree: [] },
                'https://api.db.nomics.world/v22/datasets/IMF?limit=100&offset=0': {
                    datasets: { docs: [{ code: 'AFRREO', name: 'Sub-Saharan Africa', nb_series: 1654 }], limit: 100, offset: 0, num_found: 1 }
                }
            });
            vi.stubGlobal('fetch', fetchMock);

            const connector = new Connector({} as never, []);
            const result = await connector.listNodes({ folderPath: '/IMF' } as ListNodesOptions);

            expect(result.connectionNodeConfigs).toEqual([expect.objectContaining({ id: 'AFRREO', childCount: 1654, typeId: 'folder', folderPath: '/IMF' })]);
        });

        it('rejects a path that tries to descend past a resolved dataset leaf', async () => {
            const fetchMock = buildRoutedFetchMock({
                'https://api.db.nomics.world/v22/providers/PROV': { category_tree: [{ code: 'DS1', name: 'Dataset One' }] }
            });
            vi.stubGlobal('fetch', fetchMock);

            const connector = new Connector({} as never, []);
            await expect(connector.listNodes({ folderPath: '/PROV/DS1/EXTRA' } as ListNodesOptions)).rejects.toThrow(/invalid folder path/i);
        });

        it('rejects a path segment with no matching category or dataset code', async () => {
            const fetchMock = buildRoutedFetchMock({
                'https://api.db.nomics.world/v22/providers/PROV': { category_tree: [{ code: 'A', name: 'A', children: [{ code: 'X1', name: 'x1' }] }] }
            });
            vi.stubGlobal('fetch', fetchMock);

            const connector = new Connector({} as never, []);
            await expect(connector.listNodes({ folderPath: '/PROV/ZZZ' } as ListNodesOptions)).rejects.toThrow(/invalid folder path/i);
        });

        it('rejects an invalid folder path', async () => {
            const connector = new Connector({} as never, []);
            await expect(connector.listNodes({ folderPath: 'no-leading-slash' } as ListNodesOptions)).rejects.toThrow(/invalid folder path/i);
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

        it('previews a series reached through category_tree levels, ignoring the category segments in the path', async () => {
            const fetchMock = vi.fn().mockResolvedValue(
                buildFetchResponse({
                    series: { docs: [{ series_code: 'A.FR.PIB', series_name: 'French GDP', period: ['2000'], value: [1.1] }], num_found: 1 }
                })
            );
            vi.stubGlobal('fetch', fetchMock);

            const connector = new Connector(buildConnectorUtilities(), []);
            // Provider -> category -> subcategory -> dataset -> series: two category segments between provider and dataset.
            const result = await connector.previewObject({ path: '/INSEE/ECO/ECO_GENERALE/CNA-2010-PIB/A.FR.PIB' } as PreviewObjectOptions);

            // The category segments (ECO/ECO_GENERALE) are dropped -- series are only keyed on provider/dataset/seriesCode.
            expectProxiedFetch(fetchMock, 'https://api.db.nomics.world/v22/series/INSEE/CNA-2010-PIB/A.FR.PIB?observations=1');
            expect(result.parsedRecords).toHaveLength(2);
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

    describe('getInfo', () => {
        afterEach(() => {
            vi.unstubAllGlobals();
        });

        it('returns the provider metadata for a bare provider path', async () => {
            const providerInfo = { code: 'IMF', name: 'International Monetary Fund', region: 'World' };
            const fetchMock = buildRoutedFetchMock({
                'https://api.db.nomics.world/v22/providers/IMF': { category_tree: [], provider: providerInfo }
            });
            vi.stubGlobal('fetch', fetchMock);

            const connector = new Connector({} as never, []);
            const result = await connector.getInfo({ path: '/IMF' } as GetInfoOptions);

            expect(result.info).toEqual(providerInfo);
        });

        it('returns the raw category node for a path resolving to a category', async () => {
            const fetchMock = buildRoutedFetchMock({
                'https://api.db.nomics.world/v22/providers/INSEE': {
                    category_tree: [{ code: 'ECO', name: 'Economy', doc_href: 'https://example.com/eco', children: [{ code: 'GEN', name: 'General' }] }]
                }
            });
            vi.stubGlobal('fetch', fetchMock);

            const connector = new Connector({} as never, []);
            const result = await connector.getInfo({ path: '/INSEE/ECO' } as GetInfoOptions);

            expect(result.info).toEqual({ code: 'ECO', name: 'Economy', doc_href: 'https://example.com/eco', children: [{ code: 'GEN', name: 'General' }] });
        });

        it('returns full dataset metadata for a path resolving to a dataset leaf via category_tree', async () => {
            const datasetInfo = { code: 'CNA-2010-PIB', name: 'GDP', description: 'Gross domestic product', nb_series: 42 };
            const fetchMock = buildRoutedFetchMock({
                'https://api.db.nomics.world/v22/providers/INSEE': {
                    category_tree: [{ code: 'ECO', name: 'Economy', children: [{ code: 'CNA-2010-PIB', name: 'GDP' }] }]
                },
                'https://api.db.nomics.world/v22/datasets/INSEE/CNA-2010-PIB': { datasets: { docs: [datasetInfo], limit: 1, offset: 0, num_found: 1 } }
            });
            vi.stubGlobal('fetch', fetchMock);

            const connector = new Connector({} as never, []);
            const result = await connector.getInfo({ path: '/INSEE/ECO/CNA-2010-PIB' } as GetInfoOptions);

            expect(result.info).toEqual(datasetInfo);
        });

        it('returns series metadata (no observations) for a path one segment past a resolved dataset leaf', async () => {
            const seriesInfo = { series_code: 'A.FR.PIB', series_name: 'French GDP', dimensions: { GEO: 'FR' } };
            const fetchMock = buildRoutedFetchMock({
                'https://api.db.nomics.world/v22/providers/INSEE': {
                    category_tree: [{ code: 'ECO', name: 'Economy', children: [{ code: 'CNA-2010-PIB', name: 'GDP' }] }]
                },
                'https://api.db.nomics.world/v22/series/INSEE/CNA-2010-PIB/A.FR.PIB': { series: { docs: [seriesInfo], limit: 1, offset: 0, num_found: 1 } }
            });
            vi.stubGlobal('fetch', fetchMock);

            const connector = new Connector({} as never, []);
            const result = await connector.getInfo({ path: '/INSEE/ECO/CNA-2010-PIB/A.FR.PIB' } as GetInfoOptions);

            expect(result.info).toEqual(seriesInfo);
        });

        it('falls back to the flat dataset/series shape when category_tree is empty', async () => {
            const datasetInfo = { code: 'AFRREO', name: 'Sub-Saharan Africa', nb_series: 1654 };
            const seriesInfo = { series_code: 'A.NGDP', series_name: 'GDP' };
            const fetchMock = buildRoutedFetchMock({
                'https://api.db.nomics.world/v22/providers/IMF': { category_tree: [] },
                'https://api.db.nomics.world/v22/datasets/IMF/AFRREO': { datasets: { docs: [datasetInfo], limit: 1, offset: 0, num_found: 1 } },
                'https://api.db.nomics.world/v22/series/IMF/AFRREO/A.NGDP': { series: { docs: [seriesInfo], limit: 1, offset: 0, num_found: 1 } }
            });
            vi.stubGlobal('fetch', fetchMock);

            const connector = new Connector({} as never, []);
            const datasetResult = await connector.getInfo({ path: '/IMF/AFRREO' } as GetInfoOptions);
            const seriesResult = await connector.getInfo({ path: '/IMF/AFRREO/A.NGDP' } as GetInfoOptions);

            expect(datasetResult.info).toEqual(datasetInfo);
            expect(seriesResult.info).toEqual(seriesInfo);
        });

        it('rejects a path that tries to descend past a resolved series', async () => {
            const fetchMock = buildRoutedFetchMock({
                'https://api.db.nomics.world/v22/providers/IMF': { category_tree: [] }
            });
            vi.stubGlobal('fetch', fetchMock);

            const connector = new Connector({} as never, []);
            await expect(connector.getInfo({ path: '/IMF/AFRREO/A.NGDP/EXTRA' } as GetInfoOptions)).rejects.toThrow(/invalid object path/i);
        });

        it('reuses the cached category_tree fetch across getInfo calls for the same provider', async () => {
            const fetchMock = buildRoutedFetchMock({
                'https://api.db.nomics.world/v22/providers/INSEE': {
                    category_tree: [{ code: 'ECO', name: 'Economy', children: [{ code: 'CNA-2010-PIB', name: 'GDP' }] }],
                    provider: { code: 'INSEE', name: 'INSEE' }
                },
                'https://api.db.nomics.world/v22/datasets/INSEE/CNA-2010-PIB': { datasets: { docs: [{ code: 'CNA-2010-PIB', name: 'GDP' }], limit: 1, offset: 0, num_found: 1 } }
            });
            vi.stubGlobal('fetch', fetchMock);

            const connector = new Connector({} as never, []);
            await connector.getInfo({ path: '/INSEE' } as GetInfoOptions);
            await connector.getInfo({ path: '/INSEE/ECO/CNA-2010-PIB' } as GetInfoOptions);

            // Two distinct URLs are fetched (provider/tree, and the dataset), each exactly once -- the second
            // getInfo call reuses the already-cached provider/tree response rather than re-fetching it.
            expect(fetchMock).toHaveBeenCalledTimes(2);
        });
    });
});
