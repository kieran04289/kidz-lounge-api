// NYC Early Intervention Program Consent to Release/Obtain Information
// (NYC form 8/24; Kieran, Nov 2026: "identical to NYC's page", like the
// session notes). The Power Form with these questions is shown to the parent
// and printed to PDF as NYC's own page 1 (the frontend's NycConsentForm.jsx
// and eiFormsPdf.js nycConsentSection), so its questions are fixed: saving
// the template keeps this list exactly and only takes the office's starting
// answers (lockFields). The clinic's own details in section B are starting
// answers, so none are typed here. Seeded by
// migrations/2026-10-29_power_form_packages.sql; the ids are the same.
const NYC_CONSENT_FIELDS = [
  {"id":"rel_child","type":"text","label":"Child's Name","help":null,"required":true,"prefill":"child_name"},
  {"id":"rel_ei","type":"text","label":"EI #","help":null,"required":true,"prefill":"ei_number"},
  {"id":"rel_dob","type":"date","label":"DOB","help":null,"required":true,"prefill":"child_dob"},
  {"id":"rel_address","type":"text","label":"Address","help":null,"required":true,"prefill":"address"},
  {"id":"rel_apt","type":"text","label":"Apt #","help":null,"required":false,"prefill":"address_line2"},
  {"id":"rel_city","type":"text","label":"City/Borough","help":null,"required":true,"prefill":"city"},
  {"id":"rel_state","type":"text","label":"State","help":null,"required":true,"default":"New York","prefill":"state"},
  {"id":"rel_zip","type":"text","label":"Zip Code","help":null,"required":true,"prefill":"zip"},
  {"id":"rel_parent","type":"text","label":"I, (Parent/Guardian's Full Name)","help":"seek services for my child from the NYC Early Intervention Program. I understand that the providers (including evaluators, service providers and service coordinators) offering Early Intervention (EI) services to my child and family may need to exchange information to develop and carry out the Individualized Family Service Plan (IFSP).","required":true,"prefill":"parent_name"},
  {"id":"rel_direction","type":"choice","label":"(Check ONLY one)","help":null,"required":true,"options":["I authorize for the information below to be released","I authorize for the information below to be obtained"],"default":"I authorize for the information below to be released"},
  {"id":"rel_info","type":"checkboxes","label":"Specific information to be released/obtained:","help":null,"required":true,"options":["EI Medical Form","Multidisciplinary Evaluation","Supplemental Evaluation(s)","Individualized Family Service Plan","Provider Progress Notes","Session Notes","Other"],"default":["EI Medical Form","Multidisciplinary Evaluation","Supplemental Evaluation(s)","Individualized Family Service Plan","Provider Progress Notes","Session Notes"]},
  {"id":"rel_supplemental","type":"text","label":"Supplemental Evaluation(s) Specify:","help":null,"required":false},
  {"id":"rel_info_other","type":"text","label":"Other:","help":null,"required":false},
  {"id":"rel_abc","type":"checkboxes","label":"I authorize for the information to be (check/complete either A, B, or C):","help":null,"required":true,"options":["A. Released to all EI providers providing evaluation, service coordination, or services to my child and family","B. Released to the Individual/Agency below","C. Obtained from the Individual/Agency below"],"default":["A. Released to all EI providers providing evaluation, service coordination, or services to my child and family","B. Released to the Individual/Agency below"]},
  {"id":"rel_b_h","type":"heading","label":"B. Released to the Individual/Agency below:","help":null,"required":false},
  {"id":"rel_b_name","type":"text","label":"(Name/ Organization)","help":null,"required":false},
  {"id":"rel_b_address","type":"text","label":"(Street Address, Borough/City, Zip Code)","help":null,"required":false},
  {"id":"rel_b_phone","type":"phone","label":"(Telephone Number)","help":null,"required":false},
  {"id":"rel_b_fax","type":"phone","label":"(Fax Number)","help":null,"required":false},
  {"id":"rel_c_h","type":"heading","label":"C. Obtained from the Individual/Agency below:","help":null,"required":false},
  {"id":"rel_c_name","type":"text","label":"(Name/ Organization)","help":null,"required":false},
  {"id":"rel_c_address","type":"text","label":"(Street Address, Borough/City, Zip Code)","help":null,"required":false},
  {"id":"rel_c_phone","type":"phone","label":"(Telephone Number)","help":null,"required":false},
  {"id":"rel_c_fax","type":"phone","label":"(Fax Number)","help":null,"required":false},
  {"id":"rel_to_h","type":"heading","label":"The information will be sent to:","help":null,"required":false},
  {"id":"rel_to_name","type":"text","label":"(Name/ Organization)","help":null,"required":false},
  {"id":"rel_to_address","type":"text","label":"(Street Address, Borough/City, Zip Code)","help":null,"required":false},
  {"id":"rel_to_phone","type":"phone","label":"(Telephone Number)","help":null,"required":false},
  {"id":"rel_to_fax","type":"phone","label":"(Fax Number)","help":null,"required":false},
  {"id":"rel_purpose","type":"checkboxes","label":"D. The purpose of the requested information is to: (check all that apply)","help":null,"required":false,"options":["Establish Early Intervention eligibility","Develop an Individualized Family Service Plan","Start, coordinate and monitor Early Intervention services","Inform the child's physician about my child's services and","Other"]},
  {"id":"rel_purpose_other","type":"text","label":"Other:","help":null,"required":false},
  {"id":"rel_ends","type":"date","label":"This release ends on the date of my next scheduled IFSP (or, if sooner, specify date)","help":"I understand that this release can be withdrawn at any time upon written notice to my Service Coordinator.","required":false},
  {"id":"rel_signature","type":"signature","label":"Signed","help":null,"required":true},
  {"id":"rel_relationship","type":"text","label":"Relationship to Child","help":null,"required":true,"prefill":"relationship","chart_field":"Relationship_To_Patient"},
  {"id":"rel_date","type":"date","label":"Date","help":null,"required":true,"prefill":"today"},
  {"id":"rel_note","type":"heading","label":"NOTE","help":"A reproduced copy of this signed form is deemed to have the same force and effect as the original. A new Consent to Release Information form must be signed at the initial IFSP meeting and at each IFSP review and annual meeting. Blank consent forms should never be signed by the parent.\n\nConsent to Release/Obtain Information Form 8/24","required":false},
];
const KEY_IDS = ['rel_direction', 'rel_abc', 'rel_b_name'];

// Is this field list the NYC consent? Known by its question ids, which stay
// the same when the form is renamed or copied.
const isNycConsent = (fields) => Array.isArray(fields) && KEY_IDS.every(id => fields.some(f => f && f.id === id));

// The fixed questions, each with the starting answer the builder sent for it
// (none sent = none), or the one it already had when the builder sent no
// such question.
function lockFields(sent, existing) {
  const byId = (list) => new Map((Array.isArray(list) ? list : []).filter(f => f && f.id).map(f => [f.id, f]));
  const fromSent = byId(sent);
  const fromExisting = byId(existing);
  return NYC_CONSENT_FIELDS.map(f => {
    const out = { ...f };
    delete out.default;
    const src = fromSent.get(f.id) || fromExisting.get(f.id) || f;
    if (src.default !== undefined && src.default !== null) out.default = src.default;
    return out;
  });
}

module.exports = { NYC_CONSENT_FIELDS, isNycConsent, lockFields };
