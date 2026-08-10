/* HashShelf site configuration.
 *
 * Affiliate IDs are PUBLIC by design — they appear in every outbound link, the
 * same way they do on any site using these programs. Nothing here identifies
 * the site owner; use a brand-based tracking id, never a personal name.
 *
 * Buy links (and the required disclosure) stay hidden while these are empty,
 * so the site behaves exactly as before until an id is filled in.
 */
window.HashShelfConfig = {
  // Amazon Associates tracking id, e.g. 'hashshelf-20'
  amazonTag: 'hashshelf-20',
  // Amazon marketplace host; change for a non-US primary audience
  amazonHost: 'www.amazon.com',

  // Bookshop.org affiliate id (digits from your affiliate URL), e.g. '12345'
  bookshopId: ''
};
