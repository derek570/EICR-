/**
 * Shared pagination parsing and response helpers.
 * Used by list endpoints to support limit/offset query parameters.
 */

/**
 * Parse pagination query parameters with safe defaults.
 * @param {object} query - Express req.query
 * @param {object} [defaults] - { limit: 50, maxLimit: 200 }
 * @returns {{ limit: number, offset: number }}
 */
export function parsePagination(query, defaults = { limit: 50, maxLimit: 200 }) {
  const limit = Math.min(Math.max(parseInt(query.limit) || defaults.limit, 1), defaults.maxLimit);
  const offset = Math.max(parseInt(query.offset) || 0, 0);
  return { limit, offset };
}

/**
 * Wrap data array with pagination metadata.
 * @param {Array} data - Result rows
 * @param {number} total - Total row count
 * @param {{ limit: number, offset: number }} pagination
 * @returns {{ data: Array, pagination: object }}
 */
export function paginatedResponse(data, total, { limit, offset }) {
  return {
    data,
    pagination: { total, limit, offset, hasMore: offset + data.length < total },
  };
}
