import { Controller, Get, Header, Param, Patch, Query, Req } from '@nestjs/common';
import type { UserRequest } from '../app.middleware.js';
import { NotificationService } from '../service/notification.service.js';

@Controller('/api/v1/notifications')
export class NotificationController {
    constructor(private readonly notifications: NotificationService) {}
    @Get()
    @Header('Cache-Control', 'private, no-store')
    list(@Req() req: UserRequest, @Query('before') before?: string) {
        return this.notifications.list(req.user._id, before);
    }
    @Patch('/read-all')
    @Header('Cache-Control', 'private, no-store')
    markAllRead(@Req() req: UserRequest) { return this.notifications.markAllRead(req.user._id); }
    @Patch('/:id/read')
    @Header('Cache-Control', 'private, no-store')
    markRead(@Req() req: UserRequest, @Param('id') id: string) { return this.notifications.markRead(req.user._id, id); }
}
