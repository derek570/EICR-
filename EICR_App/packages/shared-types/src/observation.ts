/**
 * Observation types.
 */

export interface Observation {
  code: 'C1' | 'C2' | 'C3' | 'FI';
  item_location: string;
  observation_text: string;
  schedule_item?: string;
  schedule_description?: string;
  photos?: string[];
}
