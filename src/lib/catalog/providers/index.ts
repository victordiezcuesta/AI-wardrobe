import { awinProvider } from "./awin";
import { genericProvider } from "./generic";
import type { CatalogProvider } from "./types";

/** Añadir una fuente nueva = implementar CatalogProvider y registrarla aquí. */
export const PROVIDERS: CatalogProvider[] = [awinProvider, genericProvider];
export const configuredProviders = () => PROVIDERS.filter((p) => p.isConfigured());
export type { CatalogProvider, FeedSource } from "./types";
