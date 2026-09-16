/**
 * Only the pure part of the notifier is tested here — route validation. The
 * rest is a thin shell over expo-notifications and is exercised on a device,
 * which the README says plainly rather than implying coverage that is absent.
 */

import { routeFromNotificationData } from '../notifier';

describe('routeFromNotificationData', () => {
  it('accepts a well-formed receipt route', () => {
    expect(routeFromNotificationData({ route: '/receipt/rcp_abc123' })).toBe('/receipt/rcp_abc123');
  });

  describe('refuses anything that is not one of our own receipt routes', () => {
    // Notification payloads are attacker-influenceable in the general case, so
    // a route is validated rather than followed. A tapped notification that can
    // navigate anywhere is an open redirect with a nicer interface.
    it.each([
      ['an absolute URL', { route: 'https://evil.example.com/steal' }],
      ['a scheme', { route: 'javascript:alert(1)' }],
      ['path traversal', { route: '/receipt/../../settings' }],
      ['a different screen', { route: '/settings' }],
      ['a nested path', { route: '/receipt/abc/edit' }],
      ['an empty id', { route: '/receipt/' }],
      ['a non-string route', { route: 42 }],
      ['no route at all', { companyId: 'northwind' }],
      ['null', null],
      ['a bare string', 'receipt'],
      ['undefined', undefined],
    ])('refuses %s', (_label, data) => {
      expect(routeFromNotificationData(data)).toBeNull();
    });
  });
});
