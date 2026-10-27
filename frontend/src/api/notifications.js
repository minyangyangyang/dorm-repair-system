import { request } from './client.js'
export const getNotifications = (page = 1, limit = 20) => request('/notifications?page=' + page + '&limit=' + limit)
export const getUnreadCount = () => request('/notifications/unread-count')
export const markNotificationRead = id => request('/notifications/' + encodeURIComponent(id) + '/read', { method: 'PATCH', body: {} })
export const markAllNotificationsRead = () => request('/notifications/read-all', { method: 'PATCH', body: {} })
