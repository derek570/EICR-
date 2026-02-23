/**
 * UK Postcode lookup using postcodes.io (free, no API key required)
 * Rate limit: 3 requests/second
 */

const cache = new Map();

/**
 * Look up a UK postcode and return town/county information.
 * @param {string} postcode - The UK postcode to look up
 * @returns {Promise<{town: string, county: string, postcode: string} | null>}
 */
export async function lookupPostcode(postcode) {
  if (!postcode) return null;

  // Normalize postcode: remove spaces, uppercase
  const normalized = postcode.replace(/\s+/g, "").toUpperCase();

  // Check cache first
  if (cache.has(normalized)) {
    return cache.get(normalized);
  }

  try {
    const response = await fetch(
      `https://api.postcodes.io/postcodes/${encodeURIComponent(normalized)}`
    );

    if (!response.ok) {
      cache.set(normalized, null);
      return null;
    }

    const data = await response.json();

    if (data.status !== 200 || !data.result) {
      cache.set(normalized, null);
      return null;
    }

    const result = {
      // For town, prefer admin_ward, then parish, then admin_district
      town: data.result.admin_ward || data.result.parish || data.result.admin_district || "",
      // For county, prefer admin_county, then region
      county: data.result.admin_county || data.result.region || "",
      // Use the formatted postcode from the API
      postcode: data.result.postcode || postcode,
    };

    cache.set(normalized, result);
    return result;
  } catch (error) {
    // Network error or other issue - don't cache failures
    return null;
  }
}

/**
 * Enrich installation details with town/county from postcode lookup.
 * AI-extracted values take precedence; lookup only fills empty fields.
 * @param {Object} installation - Installation details object
 * @returns {Promise<Object>} - Enriched installation details
 */
export async function enrichInstallationDetails(installation) {
  if (!installation?.postcode) {
    return installation;
  }

  const lookup = await lookupPostcode(installation.postcode);

  if (!lookup) {
    return installation;
  }

  return {
    ...installation,
    // Only fill in if not already provided by AI extraction
    town: installation.town || lookup.town || "",
    county: installation.county || lookup.county || "",
    // Use the properly formatted postcode from the API
    postcode: lookup.postcode || installation.postcode,
  };
}
