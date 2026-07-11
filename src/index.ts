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
    providers: DBnomicsPage<{ code: string; name: string }>;
}

interface DatasetsResponse {
    datasets: DBnomicsPage<{ code: string; name: string; nb_series: number }>;
}

interface SeriesListResponse {
    series: DBnomicsPage<{ series_code: string; series_name: string }>;
}

// ── Constants ────────────────────────────────────────────────────────────────────────────────────────────────────────

const API_BASE_URL = 'https://api.db.nomics.world/v22';
const CACHE_MAX_ENTRIES = 200; // Bounds memory for long browsing sessions; oldest page evicted once exceeded.
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour.
const DEFAULT_PAGE_SIZE = 100;
const ERROR_INVALID_FOLDER_PATH = 'Encountered invalid folder path';

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

    // Operations ──────────────────────────────────────────────────────────────────────────────────────────────────────

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

    // Lists providers, datasets, or series depending on folder depth: "" -> providers, "/{provider}" -> datasets,
    // "/{provider}/{dataset}" -> series. Fetches exactly one page per call (options.limit/offset passed straight
    // through to DBnomics); the caller drives further pages via the returned cursor/isMore/totalCount.
    async listNodes(options: ListNodesOptions): Promise<ListNodesResult> {
        const { signal } = (this.abortController = new AbortController());

        try {
            const folderPathSegments = options.folderPath.split('/');
            if (folderPathSegments[0] != '') throw new Error(`${ERROR_INVALID_FOLDER_PATH} '${options.folderPath}'.`); // Invalid folder path if characters ahead of first separator.
            const limit = options.limit ?? DEFAULT_PAGE_SIZE;
            const offset = options.offset ?? 0;
            const pageQuery = `limit=${String(limit)}&offset=${String(offset)}`;

            switch (folderPathSegments.length) {
                case 1: {
                    // Return list of provider nodes.
                    const url = `${API_BASE_URL}/providers?${pageQuery}`;
                    const data = await this.fetchCachedJson<ProvidersResponse>(url, signal);
                    const connectionNodeConfigs = data.providers.docs.map((provider) =>
                        constructFolderNodeConfig(options.folderPath, provider.code, provider.name, undefined)
                    );
                    return buildListNodesResult(connectionNodeConfigs, offset, data.providers.num_found);
                }
                case 2: {
                    const providerCode = folderPathSegments[1];
                    if (!providerCode) throw new Error(`${ERROR_INVALID_FOLDER_PATH} '${options.folderPath}'.`); // Invalid folder path if no provider code.
                    // Return list of dataset nodes for the provider.
                    const url = `${API_BASE_URL}/datasets/${providerCode}?${pageQuery}`;
                    const data = await this.fetchCachedJson<DatasetsResponse>(url, signal);
                    const connectionNodeConfigs = data.datasets.docs.map((dataset) =>
                        constructFolderNodeConfig(options.folderPath, dataset.code, dataset.name, dataset.nb_series)
                    );
                    return buildListNodesResult(connectionNodeConfigs, offset, data.datasets.num_found);
                }
                case 3: {
                    const providerCode = folderPathSegments[1];
                    const datasetCode = folderPathSegments[2];
                    if (!providerCode || !datasetCode) throw new Error(`${ERROR_INVALID_FOLDER_PATH} '${options.folderPath}'.`); // Invalid folder path if no provider/dataset code.
                    // Return list of series (leaf) nodes for the dataset.
                    const url = `${API_BASE_URL}/series/${providerCode}/${datasetCode}?${pageQuery}`;
                    const data = await this.fetchCachedJson<SeriesListResponse>(url, signal);
                    const connectionNodeConfigs = data.series.docs.map((series) =>
                        constructObjectNodeConfig(options.folderPath, series.series_code, series.series_name)
                    );
                    return buildListNodesResult(connectionNodeConfigs, offset, data.series.num_found);
                }
                default:
                    throw new Error(`${ERROR_INVALID_FOLDER_PATH} '${options.folderPath}'.`);
            }
        } catch (error) {
            throw normalizeToError(error);
        } finally {
            this.abortController = undefined;
        }
    }

    // Preview the contents of the object node with the specified path — see dpuse-connector-dropbox for a fuller reference
    async previewObject(options: PreviewObjectOptions): Promise<PreviewConfig> {
        this.abortController = new AbortController();

        try {
            await Promise.resolve();
            return {} as PreviewConfig;
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

        const response = await fetch(url, { signal });
        if (!response.ok)
            throw new ConnectorError(`DBnomics request to '${url}' failed with status ${String(response.status)}.`, 'dpuse-connector-dbnomics.index.fetchCachedJson');
        const value = (await response.json()) as T;

        this.responseCache.delete(url);
        this.responseCache.set(url, { expiresAt: Date.now() + CACHE_TTL_MS, value });
        if (this.responseCache.size > CACHE_MAX_ENTRIES) {
            const oldestKey = this.responseCache.keys().next().value;
            if (oldestKey !== undefined) this.responseCache.delete(oldestKey);
        }

        return value;
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────────

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
