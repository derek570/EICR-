import { describe, expect, it, vi } from 'vitest';
import {
  AdminUserListSchema,
  CCUAnalysisSchema,
  CompanyJobListSchema,
  CompanyMemberListSchema,
  CompanySettingsSchema,
  CompanyStatsSchema,
  DocumentExtractionResponseSchema,
  InspectorProfileListSchema,
  InviteEmployeeResponseSchema,
  JobDetailSchema,
  JobListSchema,
  LoginResponseSchema,
  UserSchema,
  parseOrWarn,
} from '@/lib/adapters';

/**
 * Wave 2b D2 — adapter round-trip tests (FIX_PLAN E1: "adapters (new):
 * Round-trip wire ↔ UI for each shape").
 *
 * Two behaviours matter per schema:
 *   1. A realistic fixture (shape drawn from the backend's actual
 *      response, warts-and-all) parses without warnings.
 *   2. A deliberately broken fixture logs a warning and returns raw.
 *
 * The "returns raw" contract is load-bearing — `parseOrWarn` is the
 * ingress contract for every api-client response, and any regression
 * to throwing semantics would crash the inspector mid-certificate on
 * a prompt evolution (see `adapters/validate.ts` for rationale).
 */

function withWarnSpy<T>(fn: () => T): { result: T; warnCalls: unknown[][] } {
  const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const result = fn();
    return { result, warnCalls: spy.mock.calls };
  } finally {
    spy.mockRestore();
  }
}

describe('parseOrWarn contract', () => {
  it('returns parsed data on success without warning', () => {
    const { result, warnCalls } = withWarnSpy(() =>
      parseOrWarn(UserSchema, { id: 'u1', email: 'a@b', name: 'A' }, 'test')
    );
    expect(result).toMatchObject({ id: 'u1', email: 'a@b', name: 'A' });
    expect(warnCalls).toHaveLength(0);
  });

  it('returns raw data (unchanged) on drift + logs a single warning', () => {
    // Missing required `id` — this is how a backend contract break
    // shows up in practice. The adapter MUST NOT throw; the inspector
    // keeps working and we see the warning in the console.
    const raw = { email: 'a@b', name: 'A' };
    const { result, warnCalls } = withWarnSpy(() =>
      parseOrWarn(UserSchema, raw, 'GET /api/auth/me')
    );
    // Reference equality proves we got the RAW back, not a fresh
    // object assembled by zod's `.safeParse(..).data`.
    expect(result).toBe(raw);
    expect(warnCalls).toHaveLength(1);
    expect(String(warnCalls[0][0])).toMatch(/GET \/api\/auth\/me/);
  });
});

describe('UserSchema + LoginResponseSchema', () => {
  it('accepts a realistic login response with role + company_role', () => {
    const fixture = {
      token: 'ey...',
      user: {
        id: 'u1',
        email: 'inspector@certomatic.co.uk',
        name: 'Derek',
        role: 'admin' as const,
        company_id: 'c1',
        company_role: 'owner' as const,
      },
    };
    const result = LoginResponseSchema.parse(fixture);
    expect(result.user.company_role).toBe('owner');
  });

  it('accepts the legacy user shape (no company binding)', () => {
    const fixture = { id: 'u0', email: 'legacy@x.co', name: 'Legacy' };
    expect(() => UserSchema.parse(fixture)).not.toThrow();
  });

  it('rejects an unknown role enum', () => {
    const raw = { id: 'u1', email: 'a@b', name: 'A', role: 'god' };
    const { result, warnCalls } = withWarnSpy(() => parseOrWarn(UserSchema, raw, 'test'));
    expect(result).toBe(raw);
    expect(warnCalls).toHaveLength(1);
  });
});

describe('JobListSchema + JobDetailSchema', () => {
  it('accepts a dashboard-shaped list response', () => {
    const fixture = [
      {
        id: 'j1',
        address: '12 High St',
        status: 'done' as const,
        created_at: '2026-04-01',
        updated_at: '2026-04-02',
        certificate_type: 'EICR' as const,
      },
      {
        id: 'j2',
        address: '',
        status: 'pending' as const,
        created_at: '2026-04-05',
      },
    ];
    const result = JobListSchema.parse(fixture);
    expect(result).toHaveLength(2);
    expect(result[1].status).toBe('pending');
  });

  it('accepts a full tab payload with permissive section bags', () => {
    const fixture = {
      id: 'j1',
      address: '12 High St',
      status: 'processing' as const,
      created_at: '2026-04-01',
      // Free-form bags — the schema does not enforce keys inside.
      installation: { client_name: 'Jane', weird_new_field: true },
      extent: {},
      supply: { earth_type: 'TN-S' },
      board: { board_name: 'Main' },
      circuits: [{ id: 'c1', number: '1', description: 'Lighting', extra: 42 }],
      observations: [
        {
          id: 'o1',
          code: 'C2' as const,
          description: 'Loose terminal',
          photos: ['photo_1.jpg'],
        },
      ],
      ccu_analysis_by_board: {
        board1: { board_model: 'Hager VML', spd_present: true },
      },
      last_session_id: 'sess-xyz',
    };
    const result = JobDetailSchema.parse(fixture);
    expect(result.circuits?.[0].id).toBe('c1');
    // Passthrough: `extra` survives the parse.
    expect((result.circuits?.[0] as unknown as { extra: number }).extra).toBe(42);
    expect(result.ccu_analysis_by_board?.board1.board_model).toBe('Hager VML');
  });

  it('flags an invalid observation code but still returns the payload', () => {
    const raw = {
      id: 'j1',
      address: '',
      status: 'pending',
      created_at: '2026-04-01',
      observations: [{ id: 'o1', code: 'C9' }],
    };
    const { result, warnCalls } = withWarnSpy(() =>
      parseOrWarn(JobDetailSchema, raw, 'GET /api/job/:id')
    );
    expect(result).toBe(raw);
    expect(warnCalls).toHaveLength(1);
  });
});

describe('CCUAnalysisSchema', () => {
  it('accepts a multi-circuit analysis with nulls + passthrough', () => {
    const fixture = {
      board_manufacturer: 'Hager',
      board_model: 'VML',
      main_switch_rating: '100',
      main_switch_bs_en: 'EN 60947',
      main_switch_type: null, // Sonnet returns null when unreadable.
      main_switch_poles: '2',
      main_switch_current: null,
      main_switch_voltage: '230',
      main_switch_position: 'left' as const,
      spd_present: true,
      spd_bs_en: 'EN 61643',
      spd_type: 'T2',
      spd_rated_current_a: null,
      spd_short_circuit_ka: null,
      circuits: [
        {
          circuit_number: 1,
          label: 'Lights',
          ocpd_type: 'B' as const,
          ocpd_rating_a: '6',
          ocpd_bs_en: 'EN 60898',
          ocpd_breaking_capacity_ka: '6',
          is_rcbo: false,
          rcd_protected: true,
          rcd_type: 'A' as const,
          rcd_rating_ma: '30',
          rcd_bs_en: 'EN 61008',
        },
      ],
      questionsForInspector: ['Which OCPD is the RCBO?'],
      confidence: { overall: 0.82, image_quality: 'clear' as const },
      gptVisionCost: {
        cost_usd: 0.014,
        input_tokens: 1500,
        output_tokens: 600,
        image_count: 1,
      },
      // Forward-compat field — prompt evolutions add new keys without
      // breaking the client.
      new_experimental_hint: 'watch out for meter tails',
    };
    const result = CCUAnalysisSchema.parse(fixture);
    expect(result.circuits?.[0].circuit_number).toBe(1);
    expect((result as unknown as { new_experimental_hint: string }).new_experimental_hint).toBe(
      'watch out for meter tails'
    );
  });

  it('rejects an unknown rcd_type enum but returns raw via parseOrWarn', () => {
    const raw = { circuits: [{ circuit_number: 1, rcd_type: 'Z' }] };
    const { result, warnCalls } = withWarnSpy(() =>
      parseOrWarn(CCUAnalysisSchema, raw, 'POST /api/analyze-ccu')
    );
    expect(result).toBe(raw);
    expect(warnCalls).toHaveLength(1);
  });
});

describe('DocumentExtractionResponseSchema', () => {
  it('accepts the realistic extraction envelope', () => {
    const fixture = {
      success: true,
      formData: {
        installation_details: { client_name: 'Jane' },
        supply_characteristics: { earth_type: 'TN-S' },
        board_info: { board_name: 'Main' },
        circuits: [
          {
            circuit_ref: '1',
            circuit_designation: 'Lights',
            ocpd_rating_a: '6',
          },
        ],
        observations: [
          {
            code: 'C2',
            observation_text: 'Loose terminal',
            item_location: 'CCU',
            regulation: '521.3',
          },
        ],
      },
    };
    const result = DocumentExtractionResponseSchema.parse(fixture);
    expect(result.success).toBe(true);
    expect(result.formData.circuits?.[0].circuit_ref).toBe('1');
  });
});

describe('InspectorProfileListSchema', () => {
  it('accepts profiles with + without equipment blocks', () => {
    const fixture = [
      {
        id: 'p1',
        name: 'Derek',
        position: 'Inspector',
        organisation: 'BE Ltd',
        enrolment_number: 'NIC-123',
        signature_file: 'settings/u1/signatures/sig_1.png',
        is_default: true,
      },
      {
        id: 'p2',
        name: 'Partner',
        mft_serial_number: 'MF123',
        mft_calibration_date: '2025-06-01',
        // Equipment fields are optional — partial block is fine.
      },
    ];
    const result = InspectorProfileListSchema.parse(fixture);
    expect(result).toHaveLength(2);
    expect(result[0].is_default).toBe(true);
  });
});

describe('CompanySettingsSchema', () => {
  it('accepts a fully-populated branding blob', () => {
    const fixture = {
      company_name: 'BE Ltd',
      company_address: '1 High St',
      company_phone: '0207',
      company_email: 'hello@be.co.uk',
      company_website: 'https://be.co.uk',
      company_registration: '12345678',
      logo_file: 'settings/u1/logos/logo_1.png',
    };
    expect(() => CompanySettingsSchema.parse(fixture)).not.toThrow();
  });

  it('accepts the empty-defaults blob returned when no branding is set', () => {
    expect(() => CompanySettingsSchema.parse({})).not.toThrow();
  });

  it('accepts explicit null to clear the logo', () => {
    const result = CompanySettingsSchema.parse({ logo_file: null });
    expect(result.logo_file).toBeNull();
  });
});

describe('CompanyMemberListSchema + CompanyJobListSchema + CompanyStatsSchema', () => {
  it('accepts a realistic team list', () => {
    const fixture = [
      {
        id: 'u1',
        email: 'owner@be.co.uk',
        name: 'Derek',
        role: 'admin' as const,
        company_role: 'owner' as const,
        is_active: true,
        last_login: '2026-04-18T07:00:00Z',
        created_at: '2025-01-01',
      },
      {
        id: 'u2',
        email: 'emp@be.co.uk',
        name: 'Partner',
        company_role: 'employee' as const,
        is_active: true,
        last_login: null,
      },
    ];
    expect(() => CompanyMemberListSchema.parse(fixture)).not.toThrow();
  });

  it('accepts a paginated jobs envelope with nullable address + employee fields', () => {
    const fixture = {
      data: [
        {
          id: 'j1',
          address: null,
          status: 'pending' as const,
          created_at: '2026-04-01',
          user_id: 'u2',
          employee_name: 'Partner',
          employee_email: null,
        },
      ],
      pagination: { limit: 50, offset: 0, total: 1, hasMore: false },
    };
    const result = CompanyJobListSchema.parse(fixture);
    expect(result.pagination.hasMore).toBe(false);
    expect(result.data[0].employee_email).toBeNull();
  });

  it('accepts a stats envelope with optional blocks', () => {
    const fixture = {
      company: { id: 'c1', name: 'BE Ltd' },
      jobs_by_status: { pending: 1, done: 3 },
      total_jobs: 4,
      active_employees: 2,
      jobs_last_7_days: 1,
    };
    expect(() => CompanyStatsSchema.parse(fixture)).not.toThrow();
  });
});

describe('InviteEmployeeResponseSchema', () => {
  it('parses the invite envelope (temporaryPassword is present exactly once)', () => {
    const fixture = {
      userId: 'u3',
      email: 'new@be.co.uk',
      name: 'New Hire',
      temporaryPassword: 'abc123def',
    };
    const result = InviteEmployeeResponseSchema.parse(fixture);
    expect(result.temporaryPassword).toBe('abc123def');
  });
});

describe('AdminUserListSchema', () => {
  it('accepts an admin listing with lifecycle flags', () => {
    const fixture = {
      data: [
        {
          id: 'u1',
          email: 'a@b',
          name: 'A',
          role: 'admin' as const,
          is_active: true,
          last_login: '2026-04-18T07:00:00Z',
          locked_until: null,
          failed_login_attempts: 0,
          created_at: '2025-01-01',
        },
      ],
      pagination: { limit: 50, offset: 0, total: 1, hasMore: false },
    };
    expect(() => AdminUserListSchema.parse(fixture)).not.toThrow();
  });
});
