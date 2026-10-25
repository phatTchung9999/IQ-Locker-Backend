import { Injectable, HttpException, HttpStatus, ConflictException, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { User, UserDocument } from "../model/user.schema.js";
import * as bcrypt from 'bcrypt';
import { JwtService } from '@nestjs/jwt';
import { userProfile } from '../dto/user-profile.js';
import { ProfileValidationPipe } from '../dto/profile.dto.js';
import { SignupValidationPipe } from '../dto/signup.dto.js';


@Injectable()
export class UserService {
    constructor(@InjectModel(User.name) private userModel: Model<UserDocument>,
    ) { }
    async signup(input: unknown): Promise<{ id: string; fullname: string; email: string; createdDate: Date }> {
        const user = new SignupValidationPipe().transform(input);
        const salt = await bcrypt.genSalt();
        const hash = await bcrypt.hash(user.password, salt);
        const reqBody = {
            fullname: user.fullname,
            email: user.email,
            password: hash
        }
        const newUser = new this.userModel(reqBody);
        try {
            const saved = await newUser.save();
            return {
                id: saved._id.toString(),
                fullname: saved.fullname,
                email: saved.email,
                createdDate: saved.createdDate,
            };
        } catch (error) {
            if (error && typeof error === 'object' && 'code' in error && error.code === 11000) {
                throw new ConflictException('An account with this email already exists');
            }
            throw error;
        }
    }
    async signin(user: User, jwt: JwtService): Promise<any> {
        const email = typeof user.email === 'string' ? user.email.trim().toLowerCase() : '';
        const foundUser = await this.userModel.findOne({ email }).exec();
        if (foundUser) {
            const { password } = foundUser;
            if (await bcrypt.compare(user.password, password)) {
                const payload = { email: foundUser.email };
                return {
                    token: jwt.sign(payload),
                    user: userProfile(foundUser),
                };
            }
            throw new HttpException('Incorrect username or password', HttpStatus.UNAUTHORIZED)
        }
        throw new HttpException('Incorrect username or password', HttpStatus.UNAUTHORIZED)
    }
    async updateProfile(email: string, input: unknown): Promise<ReturnType<typeof userProfile>> {
        const changes = new ProfileValidationPipe().transform(input);
        const updated = await this.userModel.findOneAndUpdate(
            { email }, { $set: changes }, { new: true, runValidators: true },
        ).select('fullname email phone school major -_id').exec();
        if (!updated) throw new NotFoundException('Account not found');
        return userProfile(updated);
    }
    async getOne(email: string): Promise<UserDocument | null> {
        return await this.userModel.findOne({ email }).exec();
    }
}
