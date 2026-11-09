import { BadRequestException, Body, Controller, Delete, Get, Header, HttpCode, Post, Req, Res, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Response } from 'express';
import type { UserRequest } from '../app.middleware.js';
import { AvatarService } from '../service/avatar.service.js';
import { AVATAR_MAX_BYTES } from '../dto/avatar.dto.js';

@Controller('/api/v1/user/me/avatar')
export class AvatarController {
    constructor(private readonly avatars: AvatarService) {}
    @Post()
    @HttpCode(200)
    @Header('Cache-Control', 'private, no-store')
    @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: AVATAR_MAX_BYTES, files: 1, fields: 1, fieldSize: 16 } }))
    async upload(@Req() req: UserRequest, @Res({ passthrough: true }) res: Response, @UploadedFile() file?: Express.Multer.File, @Body() fields?: Record<string, unknown>) {
        if (Object.keys(fields ?? {}).some(key => key !== 'rotation')) throw new BadRequestException('Only the rotation field is allowed.');
        const controller = new AbortController();
        const abort = () => { if (!res.writableEnded) controller.abort(); };
        req.on('aborted', abort); res.on('close', abort);
        try { return await this.avatars.upload(req.user._id, file, controller.signal, fields?.rotation); }
        finally { req.off('aborted', abort); res.off('close', abort); }
    }
    @Get()
    async content(@Req() req: UserRequest, @Res({ passthrough: true }) res: Response) {
        const controller = new AbortController();
        const close = () => controller.abort();
        res.on('close', close);
        try {
            const { stream, sizeBytes } = await this.avatars.content(req.user._id, controller.signal);
            res.set({ 'Content-Type': 'image/webp', 'Content-Length': String(sizeBytes), 'Cache-Control': 'private, no-store',
                'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline; filename="avatar.webp"',
                'Content-Security-Policy': "sandbox; default-src 'none'" });
            res.on('close', () => stream.destroy());
            return new StreamableFile(stream);
        } catch (error) { res.off('close', close); throw error; }
    }
    @Delete()
    @HttpCode(204)
    @Header('Cache-Control', 'private, no-store')
    async remove(@Req() req: UserRequest) { await this.avatars.remove(req.user._id); }
}
