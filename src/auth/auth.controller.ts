import { Body, Controller, Get, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AuthService } from './auth.service';
import { GoogleAuthDto } from './dto/google-auth.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('google')
  async googleSignIn(@Body() dto: GoogleAuthDto) {
    return this.authService.signInWithGoogle(dto.idToken);
  }

  @Get('google/init')
  googleInit(@Res() res: Response) {
    const url = this.authService.getGoogleAuthUrl();
    return res.redirect(url);
  }

  @Get('google/callback')
  async googleCallback(@Query('code') code?: string, @Query('error') error?: string) {
    if (error) {
      return {
        error,
        message: 'Google authentication was cancelled or denied.',
      };
    }

    return this.authService.exchangeGoogleCode(code || '');
  }
}
