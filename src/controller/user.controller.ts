import { Body, Controller, Get, Patch, Post, Req } from "@nestjs/common";
import { userProfile } from '../dto/user-profile.js';
import { User } from "../model/user.schema.js";
import { UserService } from "../service/user.service.js";
import { JwtService } from '@nestjs/jwt'
import { SignupValidationPipe } from '../dto/signup.dto.js';
import type { UserRequest } from '../app.middleware.js';
import { ProfileValidationPipe } from '../dto/profile.dto.js';
import type { ProfileDto } from '../dto/profile.dto.js';
import type { SignupDto } from '../dto/signup.dto.js';



@Controller('/api/v1/user')
export class UserController {
    constructor(
        private readonly userService: UserService,
        private jwtService: JwtService
    ) { }
    @Get('/me')
    me(@Req() request: UserRequest) {
        return userProfile(request.user);
    }
    @Patch('/me')
    updateProfile(@Req() request: UserRequest, @Body(ProfileValidationPipe) profile: ProfileDto) {
        return this.userService.updateProfile(request.user.email, profile);
    }
    @Post('/signup')
    async Signup(@Body(SignupValidationPipe) user: SignupDto) {
        return this.userService.signup(user);
    }
    @Post('/signin')
    async SignIn(@Body() user: User) {
        return this.userService.signin(user, this.jwtService);
    }
}
