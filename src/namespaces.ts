/**
 * The two settings namespaces this plugin sits between.
 *
 * Kept apart from `config.ts` so the publication path does not depend on the
 * configuration schema — and so the pure pipeline can be exercised without a
 * schema library loaded.
 *
 * @module dsh-aperture/namespaces
 */

/** Settings namespace this plugin owns and may be configured through. */
export const APERTURE_NAMESPACE = 'aperture';

/** Settings namespace the pi-ai adapter registers, and the one this plugin writes. */
export const PI_AI_NAMESPACE = 'llm-pi-ai';
