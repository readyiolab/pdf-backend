import { Request, Response } from 'express';
import { CloudService } from './cloud.service';

export class CloudController {
  static async getIntegrations(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        res.status(401).json({ status: 'error', message: 'Unauthorized' });
        return;
      }

      const integrations = await CloudService.getUserIntegrations(userId);
      res.json({ status: 'success', data: integrations });
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err.message || 'Failed to fetch cloud integrations' });
    }
  }

  static async connect(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        res.status(401).json({ status: 'error', message: 'Unauthorized' });
        return;
      }

      const { provider, accountEmail, accessToken, refreshToken } = req.body;
      if (!provider || !accountEmail) {
        res.status(400).json({ status: 'error', message: 'provider and accountEmail are required' });
        return;
      }

      const integration = await CloudService.connectProvider(userId, {
        provider,
        accountEmail,
        accessToken,
        refreshToken,
      });

      res.json({ status: 'success', data: integration, message: `Successfully connected ${provider}` });
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err.message || 'Failed to connect cloud provider' });
    }
  }

  static async disconnect(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        res.status(401).json({ status: 'error', message: 'Unauthorized' });
        return;
      }

      const { provider } = req.body;
      if (!provider) {
        res.status(400).json({ status: 'error', message: 'provider is required' });
        return;
      }

      await CloudService.disconnectProvider(userId, provider);
      res.json({ status: 'success', message: `Successfully disconnected ${provider}` });
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err.message || 'Failed to disconnect cloud provider' });
    }
  }

  static async getFiles(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        res.status(401).json({ status: 'error', message: 'Unauthorized' });
        return;
      }

      const provider = (req.query.provider as string) || 'gdrive';
      const files = await CloudService.getProviderFiles(userId, provider);
      res.json({ status: 'success', data: files });
    } catch (err: any) {
      res.status(400).json({ status: 'error', message: err.message || 'Failed to fetch cloud files' });
    }
  }

  static async sync(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        res.status(401).json({ status: 'error', message: 'Unauthorized' });
        return;
      }

      await CloudService.triggerWorkspaceSync(userId);
      res.json({ status: 'success', message: 'Workspace sync triggered successfully' });
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err.message || 'Failed to sync cloud workspace' });
    }
  }
}
