const text = (description, extra = {}) => ({ kind: 'text', description, ...extra });

export const coreModelPack = Object.freeze({
  atomic: 1,
  name: '@atomic/models-core',
  version: '1.0.0',
  description: 'Universal person, place, thing, and event primitives for Atomic.',
  models: [
    {
      name: 'thing',
      description: 'A distinguishable object, concept, artifact, asset, or other entity that is not better represented by a more specific loaded model.',
      attributes: {
        name: text('The ordinary human-readable name of the thing.', { required: true }),
        description: { kind: 'longtext', description: 'A concise description grounded in the source evidence.' },
        kind: text('A source-provided or inferred subtype, without inventing a new model.'),
        identifiers: { kind: 'map', description: 'External identifiers keyed by identifier system.' }
      },
      identity: [
        { fields: ['identifiers'], strength: 'strong' },
        { fields: ['name', 'kind'], strength: 'weak' }
      ],
      observe: {
        positive: ['named products', 'physical objects', 'documents', 'assets', 'concepts with stable names'],
        negative: ['people', 'geographic locations', 'occurrences anchored in time'],
        instructions: 'Use thing only when no more specific loaded model fits. Preserve the source wording.'
      },
      presentation: { label: 'Thing', title: 'name', subtitle: 'kind' }
    },
    {
      name: 'person',
      extends: 'thing',
      description: 'A human individual, living or historical.',
      attributes: {
        name: text('The person’s full display name.', { required: true }),
        givenName: text('Given or first name.'),
        familyName: text('Family or last name.'),
        email: { kind: 'email', description: 'An email address explicitly associated with the person.' },
        phone: text('A phone number explicitly associated with the person.'),
        title: text('A role or honorific stated by the source.'),
        identifiers: { kind: 'map', description: 'External identifiers keyed by system.' }
      },
      identity: [
        { fields: ['email'], strength: 'strong' },
        { fields: ['phone'], strength: 'strong' },
        { fields: ['identifiers'], strength: 'strong' },
        { fields: ['name'], strength: 'weak' }
      ],
      observe: {
        positive: ['email sender or recipient', 'signature block', 'named speaker', 'human title followed by a name'],
        negative: ['companies', 'departments', 'locations', 'product names'],
        instructions: 'Do not infer that a name denotes a person when the surrounding evidence indicates an organization, place, or product.'
      },
      presentation: { label: 'Person', title: 'name', subtitle: 'title' }
    },
    {
      name: 'place',
      extends: 'thing',
      description: 'A physical or jurisdictional location.',
      attributes: {
        name: text('The place name.', { required: true }),
        placeType: text('A source-grounded type such as address, city, district, building, state, or country.'),
        address: text('A postal or street address as written in the source.'),
        latitude: { kind: 'number', description: 'Latitude when supplied by a trusted source.' },
        longitude: { kind: 'number', description: 'Longitude when supplied by a trusted source.' },
        identifiers: { kind: 'map', description: 'External geographic identifiers keyed by system.' }
      },
      identity: [
        { fields: ['identifiers'], strength: 'strong' },
        { fields: ['latitude', 'longitude'], strength: 'strong' },
        { fields: ['address'], strength: 'medium' },
        { fields: ['name', 'placeType'], strength: 'weak' }
      ],
      observe: {
        positive: ['postal addresses', 'named jurisdictions', 'buildings', 'facilities', 'geographic coordinates'],
        negative: ['organizations named after places', 'events occurring at a place'],
        instructions: 'Represent the location itself, not an organization that happens to share its name.'
      },
      presentation: { label: 'Place', title: 'name', subtitle: 'placeType' }
    },
    {
      name: 'event',
      extends: 'thing',
      description: 'Something that happened, is happening, or is scheduled to happen.',
      attributes: {
        name: text('A concise source-grounded event label.', { required: true }),
        eventType: text('A source-provided or inferred event subtype.'),
        startsAt: { kind: 'datetime', description: 'Known or stated start time.' },
        endsAt: { kind: 'datetime', description: 'Known or stated end time.' },
        status: text('A source-grounded status such as planned, completed, delayed, or cancelled.'),
        location: { kind: 'ref', to: 'place', description: 'Where the event occurs.' },
        participants: { kind: 'list', items: { kind: 'ref', to: 'thing' }, description: 'People or things participating in the event.' },
        identifiers: { kind: 'map', description: 'External identifiers keyed by system.' }
      },
      identity: [
        { fields: ['identifiers'], strength: 'strong' },
        { fields: ['name', 'startsAt', 'location'], strength: 'medium' }
      ],
      observe: {
        positive: ['verbs describing completed actions', 'scheduled meetings', 'shipments', 'changes of status', 'dated occurrences'],
        negative: ['timeless descriptions', 'a date with no occurrence'],
        instructions: 'Prefer a specific loaded event subtype when available. Do not fabricate dates.'
      },
      presentation: { label: 'Event', title: 'name', subtitle: 'startsAt' }
    }
  ]
});

export default coreModelPack;
