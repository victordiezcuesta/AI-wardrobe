/** Una fuente de catálogo descargable (un feed de un anunciante). */
export interface FeedSource {
  provider: string;
  feedId: string;
  store: string;
  url: string;
  /** Nombres de columna del feed → campos normalizados. Valores alternativos en orden de preferencia. */
  mapping: FieldMapping;
}

export interface FieldMapping {
  id: string[]; name: string[]; link: string[]; image: string[]; price: string[];
  brand: string[]; color: string[]; category: string[]; description: string[]; stock: string[];
}

export interface CatalogProvider {
  id: string;
  isConfigured(): boolean;
  /** Feeds a los que este despliegue tiene acceso legítimo (cuenta, unión al programa, permisos). */
  discoverFeeds(): Promise<FeedSource[]>;
}
