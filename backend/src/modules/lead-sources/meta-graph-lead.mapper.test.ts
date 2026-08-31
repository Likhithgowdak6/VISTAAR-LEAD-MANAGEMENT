/**
 * The direct Graph API path must land on exactly the same facts as the spreadsheet path, because
 * it is the same form and the same answers — only the envelope differs. That is the whole reason
 * there is no second mapper, so these tests compare the two side by side rather than asserting an
 * invented shape.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

const { mapMetaGraphLead, mapMetaLeadRow, metaGraphLeadToRow } = await import('./meta-lead.mapper.js');

/** The same submission Meta would have written into the sheet, as the leads edge returns it. */
const GRAPH_LEAD = {
  id: '1234567890',
  created_time: '2026-08-25T09:00:00+0000',
  ad_id: '9001',
  ad_name: 'Aug wedding carousel',
  campaign_id: '7001',
  campaign_name: 'House Warming - Aug',
  form_id: '4001',
  is_organic: false,
  platform: 'fb',
  field_data: [
    { name: 'full_name', values: ['Riya Sharma'] },
    { name: 'phone_number', values: ['+919876543210'] },
    { name: 'email', values: ['riya@example.com'] },
    { name: 'how_would_you_describe_this_event?', values: ['house_warming'] },
    { name: 'event_date', values: ['12 January 2026'] },
    { name: 'location_/_area', values: ['Indiranagar, Bengaluru'] },
    { name: 'choose_your_candid_&_cinematic_p&v_pacakage', values: ['only_photography'] },
  ],
};

describe('metaGraphLeadToRow', () => {
  it('flattens field_data onto the same headers the sheet export uses', () => {
    const row = metaGraphLeadToRow({ lead: GRAPH_LEAD, formName: 'Event Photography Enquiry' });

    expect(row).toMatchObject({
      id: '1234567890',
      created_time: '2026-08-25T09:00:00+0000',
      full_name: 'Riya Sharma',
      phone_number: '+919876543210',
      email: 'riya@example.com',
      campaign_name: 'House Warming - Aug',
      // The leads edge does not return the form's name; the source supplies the one it knows.
      form_name: 'Event Photography Enquiry',
      is_organic: 'false',
    });
  });

  it('joins a multi-select answer rather than dropping all but the first choice', () => {
    const row = metaGraphLeadToRow({
      lead: { id: '1', created_time: '2026-01-01T00:00:00+0000', field_data: [{ name: 'services', values: ['photo', 'video'] }] },
    });

    expect(row.services).toBe('photo, video');
  });

  it('ignores a blank answer instead of writing an empty custom field', () => {
    const row = metaGraphLeadToRow({
      lead: { id: '1', created_time: '2026-01-01T00:00:00+0000', field_data: [{ name: 'notes', values: ['   '] }] },
    });

    expect(row.notes).toBeUndefined();
  });
});

describe('mapMetaGraphLead', () => {
  it('produces the identical normalized lead the sheet row would have produced', () => {
    const fromSheet = mapMetaLeadRow({
      row: {
        id: 'l:1234567890',
        created_time: '2026-08-25T09:00:00+0000',
        ad_id: 'ag:9001',
        ad_name: 'Aug wedding carousel',
        campaign_id: 'c:7001',
        campaign_name: 'House Warming - Aug',
        form_id: 'f:4001',
        form_name: 'Event Photography Enquiry',
        is_organic: 'false',
        platform: 'fb',
        full_name: 'Riya Sharma',
        phone_number: 'p:+919876543210',
        email: 'riya@example.com',
        'how_would_you_describe_this_event?': 'house_warming',
        event_date: '12 January 2026',
        'location_/_area': 'Indiranagar, Bengaluru',
        'choose_your_candid_&_cinematic_p&v_pacakage': 'only_photography',
      },
    });

    const fromGraph = mapMetaGraphLead({
      lead: GRAPH_LEAD,
      formName: 'Event Photography Enquiry',
    });

    // `raw` differs by construction (one holds the sheet row, one the flattened envelope);
    // everything the CRM actually persists and reasons about must not.
    const { raw: _sheetRaw, ...sheetFacts } = fromSheet;
    const { raw: _graphRaw, ...graphFacts } = fromGraph;

    expect(graphFacts).toEqual(sheetFacts);
  });

  it('keeps the leadgen_id as the external id, so the existing ledger dedups it', () => {
    expect(mapMetaGraphLead({ lead: GRAPH_LEAD }).externalId).toBe('1234567890');
  });

  it('still derives the canonical facts and the category the AI reads', () => {
    const lead = mapMetaGraphLead({ lead: GRAPH_LEAD });

    expect(lead.category).toBe('house_warming');
    expect(lead.canonicalFacts).toMatchObject({
      event_type: 'house warming',
      event_date: '12 January 2026',
      city: 'Indiranagar, Bengaluru',
    });
    // ADR-005: identity never reaches the AI's copy of the answers.
    expect(lead.canonicalFacts.name).toBeUndefined();
    expect(lead.canonicalFacts.phone).toBeUndefined();
  });
});
