import { z } from 'zod'

/**
 * The marketplaces this tool lists on.
 *
 * Its own module rather than a line in `types.ts` because two files need it and
 * one of them is `types.ts` itself: the listing record embeds keyword evidence,
 * and that evidence is tagged by marketplace. Left where it started, `types.ts`
 * and `seo/types.ts` would import each other, and a zod schema read during a
 * circular import is still in its temporal dead zone — the failure is a
 * ReferenceError at startup, not a type error at build.
 *
 * `types.ts` re-exports both names, so nothing else has to know this moved.
 */
export const MarketplaceSchema = z.enum(['ebay', 'etsy'])
export type Marketplace = z.infer<typeof MarketplaceSchema>
