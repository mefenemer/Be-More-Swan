// roleKey → the slug of that assistant's own page (/ai-…), for every role that has one.
//
// This committed copy is EMPTY on purpose. scripts/build-seo-html.mjs (Job 6) overwrites it in the
// deploy with the pages it generated, so links and forwards only ever point at a page that exists in
// that deploy. In an unbuilt checkout the map is empty and everything uses assistant.html?role=<key>.
window.BmsAssistantPages = {};
