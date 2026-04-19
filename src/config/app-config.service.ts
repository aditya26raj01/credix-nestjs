import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AppConfigService {
  constructor(private readonly configService: ConfigService) {}

  getRequiredString(key: string): string {
    const value = this.configService.get<string>(key);

    if (!value || !value.trim()) {
      throw new InternalServerErrorException(`Missing required environment variable: ${key}`);
    }

    return value.trim();
  }

  getString(key: string): string | undefined {
    const value = this.configService.get<string>(key);

    if (!value) {
      return undefined;
    }

    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }

  getPositiveInt(key: string, fallback: number): number {
    const value = this.getString(key);
    const parsed = Number(value ?? String(fallback));

    if (!Number.isFinite(parsed) || parsed <= 0) {
      return fallback;
    }

    return parsed;
  }

  getBoolean(key: string, fallback: boolean): boolean {
    const value = this.getString(key);

    if (value === undefined) {
      return fallback;
    }

    return value.toLowerCase() === 'true';
  }

  getStringArray(key: string, fallback: string[]): string[] {
    const value = this.getString(key);

    if (!value) {
      return fallback;
    }

    const parsed = value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);

    return parsed.length > 0 ? parsed : fallback;
  }
}
