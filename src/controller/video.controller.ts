import { BadRequestException, Body, Controller, Delete, Get, HttpStatus, Param, Post, UseInterceptors, UploadedFiles, Put, Req, Res, Query } from "@nestjs/common";
import { Video } from "../model/video.schema.js"
import { VideoService } from "../service/video.service.js";
import { FileFieldsInterceptor } from "@nestjs/platform-express";

import type { Response, Request } from "express";
import type { UserRequest } from "../app.middleware.js";

@Controller('/api/v1/video')
export class VideoController {
    constructor(private readonly videoService: VideoService){}
    @Post()
    @UseInterceptors(FileFieldsInterceptor([
        { name: 'video', maxCount: 1 },
        { name: 'cover', maxCount: 1 },
    ]))
    async createBook(@Res() response: Response, @Req() request: UserRequest, @Body() video: Video, @UploadedFiles() files: { video?: Express.Multer.File[], cover?: Express.Multer.File[] } | undefined) {
        const videoFile = files?.video?.[0];
        const coverFile = files?.cover?.[0];
        if (!videoFile || !coverFile) {
            throw new BadRequestException('Both video and cover files are required');
        }
        const requestBody = { createdBy: request.user, title: video.title, video: videoFile.filename, coverImage: coverFile.filename }
        const newVideo = await this.videoService.createVideo(requestBody);
        return response.status(HttpStatus.CREATED).json({
            newVideo
        })
    }
    @Get()
    async read(@Query('id') id: string): Promise<Object> {
        return await this.videoService.readVideo({ id });
    }
    @Get('/:id')
    async stream(@Param('id') id: string, @Res() response: Response, @Req() request: Request) {
        return this.videoService.streamVideo(id, response, request);
    }
    @Put('/:id')
    async update(@Res() response: Response, @Param('id') id: string, @Body() video: Video) {
        const updatedVideo = await this.videoService.update(id, video);
        return response.status(HttpStatus.OK).json(updatedVideo)
    }
    @Delete('/:id')
    async delete(@Res() response: Response, @Param('id') id: string) {
        await this.videoService.delete(id);
        return response.status(HttpStatus.OK).json({
            user: null
        })
    }
}
