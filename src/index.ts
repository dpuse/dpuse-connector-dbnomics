// ── DPUse Framework
import type { ConnectionNodeConfig } from '@dpuse/dpuse-shared/component/connection';
import type { ToolConfig } from '@dpuse/dpuse-shared/component/module/tool';
import type {
    AuditObjectContentOptions,
    AuditObjectContentResult,
    ConnectorConfig,
    ConnectorInterface,
    ConnectorUtilities,
    FindObjectOptions,
    FindObjectResult,
    GetInfoOptions,
    GetInfoResult,
    GetReadableStreamOptions,
    ListNodesOptions,
    ListNodesResult,
    PreviewObjectOptions,
    RecordRetrievalTypeId,
    RetrieveRecordsOptions,
    RetrieveRecordsSummary
} from '@dpuse/dpuse-shared/component/module/connector';
import { ConnectorError, normalizeToError } from '@dpuse/dpuse-shared/errors';
import type { ParsingRecord, PreviewConfig } from '@dpuse/dpuse-shared/component/dataView';

// ── Data
import config from '~/config.json';

// ── Types ────────────────────────────────────────────────────────────────────────────────────────────────────────────

// Extend default connector interface with an instance-scoped, TTL'd, LRU-bounded response cache.
interface ExtendedConnectorInterface extends ConnectorInterface {
    responseCache: Map<string, CacheEntry>;
}

interface CacheEntry {
    expiresAt: number;
    value: unknown;
}

interface DBnomicsPage<T> {
    docs: T[];
    num_found: number;
}

interface ProvidersResponse {
    providers: DBnomicsPage<{ code: string; name: string; index_at: string; region: string; slug: string; terms_of_use: string; website: string }>;
}

interface DatasetsResponse {
    datasets: DBnomicsPage<{
        code: string;
        name: string;
        description: string;
        description_code_order: string[];
        dimensions_values_labels: Record<string, Record<string, string>>[];
        dir_hash: string;
        indexed_at: string;
        nb_series: number;
        provider_code: string;
        provider_name: string;
    }>;
}

interface SeriesListResponse {
    series: DBnomicsPage<{
        series_code: string;
        series_name: string;
        dimensions: Record<string, string>[];
        index_at: string;
        provider_code: string;
        dataset_code: string;
        dataset_name: string;
    }>;
}

interface SeriesObservationsResponse {
    series: DBnomicsPage<{ series_code: string; series_name: string; period: string[]; value: (number | null)[] }>;
}

interface CategoryTreeNode {
    code: string | null; // Some providers (e.g. Bank of Indonesia, ECB) omit codes on category nodes; leaves (real datasets) always have one.
    name: string;
    children?: CategoryTreeNode[];
}

interface ProviderCategoryTreeResponse {
    category_tree: CategoryTreeNode[] | undefined;
    provider: Record<string, unknown>;
}

interface DatasetInfoResponse {
    datasets: DBnomicsPage<Record<string, unknown>>;
}

interface SeriesInfoResponse {
    series: DBnomicsPage<Record<string, unknown>>;
}

type ResolvedCategoryNode = { kind: 'category'; nodes: CategoryTreeNode[] } | { kind: 'dataset'; code: string; name: string };

// ── Constants ────────────────────────────────────────────────────────────────────────────────────────────────────────

const API_BASE_URL = 'https://api.db.nomics.world/v22';
const PROXY_URL = 'https://api.dpuse.app/proxy';
const CACHE_MAX_ENTRIES = 200; // Bounds memory for long browsing sessions; oldest page evicted once exceeded.
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour.
const DATASET_LOOKUP_PAGE_SIZE = 500; // DBnomics' own cap on `limit` for this endpoint; still one page for most providers.
const DEFAULT_PAGE_SIZE = 100;
const ERROR_INVALID_FOLDER_PATH = 'Encountered invalid folder path';
const ERROR_INVALID_OBJECT_PATH = 'Encountered invalid object path';
const PREVIEW_ROW_LIMIT = 50; // Matches dpuse-connector-dexie-js's previewObject row limit.

// ── Connectors ───────────────────────────────────────────────────────────────────────────────────────────────────────

export class Connector implements ExtendedConnectorInterface {
    abortController: AbortController | undefined;
    readonly config: ConnectorConfig;
    connectorUtilities: ConnectorUtilities;
    responseCache: Map<string, CacheEntry>;
    readonly toolConfigs;

    constructor(connectorUtilities: ConnectorUtilities, toolConfigs: ToolConfig[]) {
        this.abortController = undefined;
        this.config = config as ConnectorConfig;
        this.connectorUtilities = connectorUtilities;
        this.responseCache = new Map();
        this.toolConfigs = toolConfigs;
    }

    // Actions ─────────────────────────────────────────────────────────────────────────────────────────────────────────

    // Abort the currently running operation
    abortOperation(): void {
        if (!this.abortController) return;
        this.abortController.abort();
        this.abortController = undefined;
    }

    // Audit object content — see dpuse-connector-dropbox / dpuse-connector-file-store-emulator for a fuller reference
    async auditObjectContent(options: AuditObjectContentOptions, chunk: (rowCount: number) => void): Promise<AuditObjectContentResult> {
        this.abortController = new AbortController();

        try {
            await Promise.resolve();
            // Audit the series observations at options.path.
            return { processedRowCount: 0, durationMs: 0 };
        } catch (error) {
            throw normalizeToError(error);
        } finally {
            this.abortController = undefined;
        }
    }

    // Find the folder path containing the specified object node — see dpuse-connector-dropbox / dpuse-connector-dexie-js
    async findObject(options: FindObjectOptions): Promise<FindObjectResult> {
        this.abortController = new AbortController();

        try {
            await Promise.resolve();
            throw new Error('Not found.');
        } catch (error) {
            throw normalizeToError(error);
        } finally {
            this.abortController = undefined;
        }
    }

    // Get metadata for the node at the specified path — provider, category, dataset, or series. Returns DBnomics'
    // own response object as-is (unshaped) until a common cross-provider info shape has been reviewed. Modelled on
    // previewObject: resolve the path once, fetch (or reuse the already-cached) metadata, no row-truncation needed
    // since this is metadata, not observation data. Path resolution itself is delegated to resolveGetInfoTarget,
    // the same style split used for listNodes/resolveCategoryTreeNode.
    async getInfo(options: GetInfoOptions): Promise<GetInfoResult> {
        const { signal } = (this.abortController = new AbortController());

        try {
            const pathSegments = options.path.split('/');
            if (pathSegments[0] != '') throw new Error(`${ERROR_INVALID_OBJECT_PATH} '${options.path}'.`); // Invalid path if characters ahead of first separator.
            const providerCode = pathSegments[1];
            if (!providerCode) throw new Error(`${ERROR_INVALID_OBJECT_PATH} '${options.path}'.`); // Invalid path if no provider code.
            const remainingSegments = pathSegments.slice(2);

            // Fetch once whether the path is "just" the provider (info comes from this response's `provider` key)
            // or goes deeper (this response's `category_tree` is needed to interpret the remaining segments).
            const treeData = await this.fetchCachedJson<ProviderCategoryTreeResponse>(`${API_BASE_URL}/providers/${providerCode}`, signal);
            if (remainingSegments.length === 0) return { info: treeData.provider };

            const target = resolveGetInfoTarget(treeData.category_tree, remainingSegments, options.path);
            switch (target.kind) {
                case 'category':
                    return { info: target.node as unknown as Record<string, unknown> };
                case 'dataset':
                    return { info: await this.fetchDatasetInfo(providerCode, target.datasetCode, signal) };
                case 'series':
                    return { info: await this.fetchSeriesInfo(providerCode, target.datasetCode, target.seriesCode, signal) };
                default:
                    throw new Error(`${ERROR_INVALID_OBJECT_PATH} '${options.path}'.`);
            }
        } catch (error) {
            throw normalizeToError(error);
        } finally {
            this.abortController = undefined;
        }
    }

    // Get a readable stream for the specified object node path — see dpuse-connector-dropbox for a fuller reference
    async getReadableStream(options: GetReadableStreamOptions): Promise<ReadableStream<Uint8Array>> {
        this.abortController = new AbortController();

        try {
            return await Promise.resolve({} as ReadableStream<Uint8Array>);
        } catch (error) {
            throw normalizeToError(error);
        } finally {
            this.abortController = undefined;
        }
    }

    // Lists providers, categories, datasets, or series depending on folder depth: "" -> providers,
    // "/{provider}/..." -> walks that provider's category_tree (arbitrary depth) until it resolves either to a
    // category (list its immediate children) or a dataset (list its series). Providers and series are paged
    // through DBnomics (options.limit/offset passed straight through, one page fetched per call). Category levels
    // are not paged: the whole tree is already in memory (one cached fetch per provider) and a category's child
    // count is small (single/low-double digits), so options.limit/offset are ignored there and every child is
    // returned in one response.
    async listNodes(options: ListNodesOptions): Promise<ListNodesResult> {
        const { signal } = (this.abortController = new AbortController());

        try {
            const folderPathSegments = options.folderPath.split('/');
            if (folderPathSegments[0] != '') throw new Error(`${ERROR_INVALID_FOLDER_PATH} '${options.folderPath}'.`); // Invalid folder path if characters ahead of first separator.
            const limit = options.limit ?? DEFAULT_PAGE_SIZE;
            const offset = options.offset ?? 0;
            const pageQuery = `limit=${String(limit)}&offset=${String(offset)}`;

            if (folderPathSegments.length === 1) {
                // Return list of provider nodes.
                const url = `${API_BASE_URL}/providers?${pageQuery}`;
                const data = await this.fetchCachedJson<ProvidersResponse>(url, signal);
                const connectionNodeConfigs = data.providers.docs.map((provider) => constructFolderNodeConfig(options.folderPath, provider.code, provider.name, undefined));
                return buildListNodesResult(connectionNodeConfigs, offset, data.providers.num_found);
            }

            const providerCode = folderPathSegments[1];
            if (!providerCode) throw new Error(`${ERROR_INVALID_FOLDER_PATH} '${options.folderPath}'.`); // Invalid folder path if no provider code.
            const categorySegments = folderPathSegments.slice(2);

            const treeData = await this.fetchCachedJson<ProviderCategoryTreeResponse>(`${API_BASE_URL}/providers/${providerCode}`, signal);
            const categoryTree = treeData.category_tree;

            if (!categoryTree || categoryTree.length === 0) {
                // Defensive fallback — every provider checked live had a non-empty category_tree, but fall back to
                // the flat dataset list at the provider root rather than assume that always holds.
                if (categorySegments.length > 0) throw new Error(`${ERROR_INVALID_FOLDER_PATH} '${options.folderPath}'.`);
                const url = `${API_BASE_URL}/datasets/${providerCode}?${pageQuery}`;
                const data = await this.fetchCachedJson<DatasetsResponse>(url, signal);
                const connectionNodeConfigs = data.datasets.docs.map((dataset) => constructFolderNodeConfig(options.folderPath, dataset.code, dataset.name, dataset.nb_series));
                return buildListNodesResult(connectionNodeConfigs, offset, data.datasets.num_found);
            }

            const resolved = resolveCategoryTreeNode(categoryTree, categorySegments, options.folderPath);

            if (resolved.kind === 'dataset') {
                // Return list of series (leaf) nodes for the resolved dataset.
                const url = `${API_BASE_URL}/series/${providerCode}/${resolved.code}?${pageQuery}`;
                const data = await this.fetchCachedJson<SeriesListResponse>(url, signal);
                const connectionNodeConfigs = data.series.docs.map((series) => constructObjectNodeConfig(options.folderPath, series.series_code, series.series_name));
                return buildListNodesResult(connectionNodeConfigs, offset, data.series.num_found);
            }

            // Return all of the resolved category's immediate children in one response — unlike providers/series,
            // this isn't paged: the whole tree is already in memory and a category's child count is small.
            // Dataset-leaf children get their series count merged in from fetchDatasetSeriesCountsByCode; category
            // children get a free immediate-child count.
            const nbSeriesByCode = resolved.nodes.some((node) => !node.children) ? await this.fetchDatasetSeriesCountsByCode(providerCode, signal) : undefined;
            const connectionNodeConfigs = resolved.nodes.map((node) => {
                const childCount = node.children ? node.children.length : nbSeriesByCode?.get(node.code ?? '');
                return constructFolderNodeConfig(options.folderPath, resolveCategoryNodeCode(node), node.name, childCount);
            });
            return buildListNodesResult(connectionNodeConfigs, 0, resolved.nodes.length);
        } catch (error) {
            throw normalizeToError(error);
        } finally {
            this.abortController = undefined;
        }
    }

    // Preview a series' observations — see dpuse-connector-dexie-js's previewObject for the reference pattern this
    // follows: fetch the series once, then keep only the first PREVIEW_ROW_LIMIT rows for a quick look rather than
    // returning the full observation history. DBnomics has no server-side "first N observations" query param, so the
    // full series is fetched (small; a decades-long series is only a few KB) and truncated client-side.
    async previewObject(options: PreviewObjectOptions): Promise<PreviewConfig> {
        const { signal } = (this.abortController = new AbortController());

        try {
            const startedAt = performance.now();
            const { providerCode, datasetCode, seriesCode } = establishSeriesIdentifiers(options.path);

            const url = `${API_BASE_URL}/series/${providerCode}/${datasetCode}/${seriesCode}?observations=1`;
            const data = await this.fetchCachedJson<SeriesObservationsResponse>(url, signal);
            const series = data.series.docs[0];
            if (!series) throw new Error(`Series '${options.path}' not found.`);

            const headerRecord: ParsingRecord = [
                { value: 'period', valueWasQuoted: false },
                { value: 'value', valueWasQuoted: false }
            ];
            const dataRecords: ParsingRecord[] = series.period.slice(0, PREVIEW_ROW_LIMIT).map((period, index) => [
                { value: period, valueWasQuoted: false },
                { value: series.value[index] == null ? null : String(series.value[index]), valueWasQuoted: false }
            ]);
            const parsedRecords = [headerRecord, ...dataRecords];
            const inferenceSummary = this.connectorUtilities.inferDataTypes(parsedRecords);

            return {
                asAt: Date.now(),
                columnConfigs: inferenceSummary.columnConfigs,
                dataFormatId: 'json',
                duration: performance.now() - startedAt,
                encodingConfidenceLevel: undefined,
                encodingId: undefined,
                fileType: undefined,
                hasHeaders: inferenceSummary.hasHeaderRow,
                inferenceRecords: inferenceSummary.typedRecords,
                parsedRecords,
                recordDelimiterId: undefined,
                size: undefined,
                text: undefined,
                valueDelimiterId: undefined
            };
        } catch (error) {
            throw normalizeToError(error);
        } finally {
            this.abortController = undefined;
        }
    }

    // Retrieves all records from an object node using streaming and chunked processing — see dpuse-connector-dropbox
    async retrieveRecords(
        options: RetrieveRecordsOptions,
        chunk: (typeId: RecordRetrievalTypeId, records: ParsingRecord[]) => void,
        complete: (result: RetrieveRecordsSummary) => void
    ): Promise<void> {
        this.abortController = new AbortController();

        try {
            await Promise.resolve();
            complete({} as RetrieveRecordsSummary);
        } catch (error) {
            throw normalizeToError(error);
        } finally {
            this.abortController = undefined;
        }
    }

    // Helpers (instance) ──────────────────────────────────────────────────────────────────────────────────────────────

    // Fetch JSON from the given URL, serving from the instance-scoped cache when a non-expired entry exists. Cache
    // keys are full request URLs (path + query), so distinct limit/offset pages are cached independently and only
    // pages actually browsed are ever held in memory.
    private async fetchCachedJson<T>(url: string, signal: AbortSignal): Promise<T> {
        const cached = this.responseCache.get(url);
        if (cached && cached.expiresAt > Date.now()) {
            this.responseCache.delete(url); // Re-insert to mark as most-recently-used (Map preserves insertion order).
            this.responseCache.set(url, cached);
            return cached.value as T;
        }

        // TODO: No auth header sent — dpuse-api's /proxy route currently has no auth guard since connectors have no
        // session token to send (see ConnectorUtilities in dpuse-shared). Add an Authorization header here once a
        // token (or authenticated fetch) is threaded through to connectors, and re-add verifyAuthorisationToken on /proxy.
        const response = await fetch(PROXY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ method: 'GET', url }),
            signal
        });
        if (!response.ok) throw new ConnectorError(`DBnomics request to '${url}' failed with status ${String(response.status)}.`, 'dpuse-connector-dbnomics.index.fetchCachedJson');
        const value = (await response.json()) as T;

        this.responseCache.delete(url);
        this.responseCache.set(url, { expiresAt: Date.now() + CACHE_TTL_MS, value });
        if (this.responseCache.size > CACHE_MAX_ENTRIES) {
            const oldestKey = this.responseCache.keys().next().value;
            if (oldestKey !== undefined) this.responseCache.delete(oldestKey);
        }

        return value;
    }

    // Build a code -> series-count lookup for every dataset a provider has, for merging onto category_tree leaves
    // as their childCount. Dataset counts per provider are modest (tens to low hundreds, unlike the potentially
    // huge series-per-dataset case listNodes avoids over-fetching for), so this pages via the same cached fetch
    // with a generous page size — normally one request, cached thereafter, so it's a one-time cost per provider.
    private async fetchDatasetSeriesCountsByCode(providerCode: string, signal: AbortSignal): Promise<Map<string, number>> {
        const nbSeriesByCode = new Map<string, number>();
        let offset = 0;
        for (;;) {
            const url = `${API_BASE_URL}/datasets/${providerCode}?limit=${String(DATASET_LOOKUP_PAGE_SIZE)}&offset=${String(offset)}`;
            const data = await this.fetchCachedJson<DatasetsResponse>(url, signal);
            for (const dataset of data.datasets.docs) nbSeriesByCode.set(dataset.code, dataset.nb_series);
            offset += data.datasets.docs.length;
            if (offset >= data.datasets.num_found || data.datasets.docs.length === 0) break;
        }
        return nbSeriesByCode;
    }

    // Fetch a single dataset's full metadata (description, notes, dimensions, etc.) — a richer response than the
    // {code, name, nb_series} slice used for listing, for getInfo.
    private async fetchDatasetInfo(providerCode: string, datasetCode: string, signal: AbortSignal): Promise<Record<string, unknown>> {
        const data = await this.fetchCachedJson<DatasetInfoResponse>(`${API_BASE_URL}/datasets/${providerCode}/${datasetCode}`, signal);
        const dataset = data.datasets.docs[0];
        if (!dataset) throw new Error(`Dataset '${providerCode}/${datasetCode}' not found.`);
        return dataset;
    }

    // Fetch a single series' metadata (no `observations=1` — this is for getInfo, not previewObject, so period/value
    // arrays aren't needed).
    private async fetchSeriesInfo(providerCode: string, datasetCode: string, seriesCode: string, signal: AbortSignal): Promise<Record<string, unknown>> {
        const data = await this.fetchCachedJson<SeriesInfoResponse>(`${API_BASE_URL}/series/${providerCode}/${datasetCode}/${seriesCode}`, signal);
        const series = data.series.docs[0];
        if (!series) throw new Error(`Series '${providerCode}/${datasetCode}/${seriesCode}' not found.`);
        return series;
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────────

// Walk a provider's category_tree by matching each folder-path segment against a node code at that level. A node
// with `children` is a category (descend into it); a node without `children` is a dataset leaf, which must be the
// last segment (there's nothing to descend into further — series-listing takes over from there).
// Some providers (e.g. Bank of Indonesia, ECB) omit `code` on category nodes — only leaves (real datasets) are
// guaranteed one. Fall back to `name` as the path-segment identifier when `code` is missing, since it's the only
// other reasonably stable field available; '/' is escaped since folder paths are split on it.
function resolveCategoryNodeCode(node: CategoryTreeNode): string {
    return node.code ?? node.name.replaceAll('/', '⁄');
}

function resolveCategoryTreeNode(nodes: CategoryTreeNode[], segments: string[], folderPath: string): ResolvedCategoryNode {
    let currentNodes = nodes;
    for (const [index, segment] of segments.entries()) {
        const found = currentNodes.find((node) => resolveCategoryNodeCode(node) === segment);
        if (!found) throw new Error(`${ERROR_INVALID_FOLDER_PATH} '${folderPath}'.`);
        if (found.children) {
            currentNodes = found.children;
        } else if (index === segments.length - 1) {
            if (found.code == null) throw new Error(`Encountered dataset '${found.name}' with no code at '${folderPath}'.`);
            return { kind: 'dataset', code: found.code, name: found.name };
        } else {
            throw new Error(`${ERROR_INVALID_FOLDER_PATH} '${folderPath}'.`); // Tried to descend past a dataset leaf.
        }
    }
    return { kind: 'category', nodes: currentNodes };
}

// Walk segments through the category tree, returning the node found at the end (a category-with-children, or a
// dataset leaf) — unlike resolveCategoryTreeNode, which resolves to "the children of this path" (for listNodes),
// this resolves to "the node at this path itself" (for getInfo). Returns undefined if any segment doesn't match.
function findCategoryTreeNode(nodes: CategoryTreeNode[], segments: string[]): CategoryTreeNode | undefined {
    let currentNodes = nodes;
    let found: CategoryTreeNode | undefined;
    for (const segment of segments) {
        found = currentNodes.find((node) => resolveCategoryNodeCode(node) === segment);
        if (!found) return undefined;
        currentNodes = found.children ?? [];
    }
    return found;
}

type GetInfoTarget = { kind: 'category'; node: CategoryTreeNode } | { kind: 'dataset'; datasetCode: string } | { kind: 'series'; datasetCode: string; seriesCode: string };

// Resolve a getInfo path's remaining segments for a flat provider (no category_tree, mirroring listNodes' own
// fallback): [datasetCode] or [datasetCode, seriesCode].
function resolveFlatGetInfoTarget(remainingSegments: string[], path: string): GetInfoTarget {
    if (remainingSegments.length === 1) {
        const datasetCode = remainingSegments[0];
        if (datasetCode) return { kind: 'dataset', datasetCode };
    } else if (remainingSegments.length === 2) {
        const [datasetCode, seriesCode] = remainingSegments;
        if (datasetCode && seriesCode) return { kind: 'series', datasetCode, seriesCode };
    }
    throw new Error(`${ERROR_INVALID_OBJECT_PATH} '${path}'.`);
}

// Resolve the segments of a getInfo path (after the provider) against a provider's category tree (or, if the
// provider has no tree, against the flat [datasetCode] / [datasetCode, seriesCode] shape listNodes falls back to).
function resolveGetInfoTarget(categoryTree: CategoryTreeNode[] | undefined, remainingSegments: string[], path: string): GetInfoTarget {
    if (!categoryTree || categoryTree.length === 0) return resolveFlatGetInfoTarget(remainingSegments, path);

    // Try resolving the full segments directly against the tree first -- a category or a dataset.
    const directNode = findCategoryTreeNode(categoryTree, remainingSegments);
    if (directNode) {
        if (directNode.children) return { kind: 'category', node: directNode };
        if (directNode.code == null) throw new Error(`Encountered dataset '${directNode.name}' with no code at '${path}'.`);
        return { kind: 'dataset', datasetCode: directNode.code };
    }

    // Otherwise, the last segment may be a series code sitting under a resolved dataset leaf.
    if (remainingSegments.length >= 2) {
        const datasetNode = findCategoryTreeNode(categoryTree, remainingSegments.slice(0, -1));
        const seriesCode = remainingSegments.at(-1);
        if (datasetNode && !datasetNode.children && datasetNode.code != null && seriesCode) {
            return { kind: 'series', datasetCode: datasetNode.code, seriesCode };
        }
    }

    throw new Error(`${ERROR_INVALID_OBJECT_PATH} '${path}'.`);
}

// Split an object path ("/{provider}/{...categorySegments}/{dataset}/{seriesCode}") into the three identifiers a
// series needs. Category segments (if any) sit between provider and dataset and are irrelevant here — series are
// keyed only on (provider, dataset, seriesCode) — so the provider is always segment 1, the series code is always
// the last segment, and the dataset code is always the second-to-last, however many category levels lie between.
function establishSeriesIdentifiers(path: string): { providerCode: string; datasetCode: string; seriesCode: string } {
    const pathSegments = path.split('/');
    const providerCode = pathSegments[1];
    const datasetCode = pathSegments.at(-2);
    const seriesCode = pathSegments.at(-1);
    if (pathSegments.length < 4 || pathSegments[0] !== '' || !providerCode || !datasetCode || !seriesCode) {
        throw new Error(`${ERROR_INVALID_OBJECT_PATH} '${path}'.`);
    }
    return { providerCode, datasetCode, seriesCode };
}

// Construct a folder node configuration for a provider or dataset.
function constructFolderNodeConfig(folderPath: string, code: string, name: string, childCount: number | undefined): ConnectionNodeConfig {
    return {
        childCount,
        childNodes: [],
        extension: undefined,
        folderPath,
        handle: undefined,
        id: code, // DBnomics codes are stable, unique, natural keys — reused as-is rather than a random id.
        label: name,
        lastModifiedAt: undefined,
        mimeType: undefined,
        name: code,
        size: undefined,
        typeId: 'folder'
    };
}

// Construct an object (leaf) node configuration for a series.
function constructObjectNodeConfig(folderPath: string, code: string, name: string): ConnectionNodeConfig {
    return {
        childCount: undefined,
        childNodes: [],
        extension: undefined,
        folderPath,
        handle: undefined,
        id: code,
        label: name,
        lastModifiedAt: undefined,
        mimeType: undefined,
        name: code,
        size: undefined,
        typeId: 'object'
    };
}

// Compute the cursor/isMore/totalCount for a single page of DBnomics results.
function buildListNodesResult(connectionNodeConfigs: ConnectionNodeConfig[], offset: number, numberFound: number): ListNodesResult {
    const nextOffset = offset + connectionNodeConfigs.length;
    const isMore = nextOffset < numberFound;
    return { cursor: isMore ? nextOffset : undefined, connectionNodeConfigs, isMore, totalCount: numberFound };
}
