import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, Res, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Response } from 'express';
import type { UserRequest } from '../app.middleware.js';
import { MaterialService } from '../service/material.service.js';
import { materialLimits } from '../dto/material.dto.js';
@Controller('/api/v1/courses/:courseId/materials')
export class MaterialController {
    constructor(private readonly materials: MaterialService) {}
    @Get() list(@Req() req: UserRequest, @Param('courseId') course: string, @Query('folder') folder?: string) { return this.materials.list(req.user._id, course, folder); }
    @Post()
    @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: materialLimits().maxFileBytes, files: 1, fields: 1, fieldSize: 1024 } }))
    async upload(@Req() req: UserRequest, @Res({ passthrough: true }) res: Response, @Param('courseId') course: string, @Query('folder') folder: string | undefined, @UploadedFile() file: Express.Multer.File, @Body('title') title?: unknown) {
        const controller = new AbortController();
        const abort = () => { if (!res.writableEnded) controller.abort(); };
        req.on('aborted', abort); res.on('close', abort);
        try { return await this.materials.upload(req.user._id, course, folder, file, title, controller.signal); }
        finally { req.off('aborted', abort); res.off('close', abort); }
    }
    @Get('/:materialId') read(@Req() req: UserRequest, @Param('courseId') course: string, @Param('materialId') id: string) { return this.materials.read(req.user._id, course, id); }
    @Patch('/:materialId') rename(@Req() req: UserRequest, @Param('courseId') course: string, @Param('materialId') id: string, @Body() input: unknown) { return this.materials.rename(req.user._id, course, id, input); }
    @Delete('/:materialId') @HttpCode(204) async delete(@Req() req: UserRequest, @Param('courseId') course: string, @Param('materialId') id: string) { await this.materials.delete(req.user._id, course, id); }
    @Get('/:materialId/content')
    async content(@Req() req: UserRequest, @Res({ passthrough: true }) res: Response, @Param('courseId') course: string, @Param('materialId') id: string, @Query('download') download?: string) {
        const { material, stream } = await this.materials.content(req.user._id, course, id);
        res.set({ 'Content-Type': material.mediaType, 'Content-Length': String(material.sizeBytes), 'Cache-Control': 'private, no-store',
            'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'",
            'Content-Disposition': `${download === '1' ? 'attachment' : 'inline'}; filename="document.${material.mediaType === 'application/pdf' ? 'pdf' : 'txt'}"; filename*=UTF-8''${encodeURIComponent(material.originalFilename)}` });
        const close = () => stream.destroy();
        res.on('close', close); stream.on('end', () => res.off('close', close));
        return new StreamableFile(stream);
    }
}
