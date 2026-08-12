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
      // Plan E (feedback id 125) — admin_ward is an ELECTORAL WARD, not a
      // town (it silently overwrote a correct "Lower Earley" with the ward
      // "Hawkedon" in the field session that triggered this fix). Prefer
      // parish, then admin_district; never admin_ward.
      town: data.result.parish || data.result.admin_district || "",
      // Plan E — `region` yields "South East" for ~40% of England (every
      // unitary authority, which has no admin_county) — the exact drift
      // value the postcode-snapshot-applier's UK_REGION_DRIFT set exists to
      // correct downstream; reading it here re-manufactures the drift at
      // the source. Blank-on-unknown beats wrong: no ceremonial-county
      // table this wave (RESOLVED — see PLAN-E E3).
      county: data.result.admin_county || "",
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
