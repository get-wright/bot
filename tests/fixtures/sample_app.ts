import express, { Request, Response } from 'express';
import { Pool } from 'pg';

const pool = new Pool();

export async function getUser(req: Request, res: Response): Promise<void> {
    const userId: string = req.params.id;
    const result = await pool.query(`SELECT * FROM users WHERE id = '${userId}'`);
    res.json(result.rows);
}

export function renderPage(req: Request, res: Response): void {
    const title: string = req.query.title as string;
    res.send(`<html><head><title>${title}</title></head></html>`);
}

export function safeEndpoint(req: Request, res: Response): void {
    const id: number = parseInt(req.params.id, 10);
    res.json({ id });
}
