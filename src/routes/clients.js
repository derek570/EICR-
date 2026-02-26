/**
 * CRM routes — clients and properties
 */

import { Router } from 'express';
import * as auth from '../auth.js';
import * as db from '../db.js';
import {
  getClients,
  createClient,
  updateClient,
  deleteClient,
  getClient,
  getProperties,
  createProperty,
  getPropertiesByClient,
  getClientsPaginated,
  getPropertiesPaginated,
} from '../db.js';
import { parsePagination, paginatedResponse } from '../utils/pagination.js';
import logger from '../logger.js';

const router = Router();

// ============= Clients =============

router.get('/clients/:userId', auth.requireAuth, async (req, res) => {
  const { userId } = req.params;
  if (req.user.id !== userId) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const isPaginated = req.query.limit !== undefined || req.query.offset !== undefined;

    if (isPaginated) {
      const { limit, offset } = parsePagination(req.query);
      const { rows, total } = await getClientsPaginated(userId, limit, offset);
      res.json(paginatedResponse(rows, total, { limit, offset }));
    } else {
      const clients = await getClients(userId);
      res.json(clients);
    }
  } catch (error) {
    logger.error('Failed to list clients', { userId, error: error.message });
    res.status(500).json({ error: 'Failed to list clients' });
  }
});

router.post('/clients/:userId', auth.requireAuth, async (req, res) => {
  const { userId } = req.params;
  const { name, email, phone, company, notes } = req.body;
  if (req.user.id !== userId) {
    return res.status(403).json({ error: 'Access denied' });
  }
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Client name is required' });
  }
  try {
    const client = await createClient({
      user_id: userId,
      name: name.trim(),
      email: email || null,
      phone: phone || null,
      company: company || null,
      notes: notes || null,
    });
    logger.info('Client created', { userId, clientId: client.id });
    res.json(client);
  } catch (error) {
    logger.error('Failed to create client', { userId, error: error.message });
    res.status(500).json({ error: 'Failed to create client' });
  }
});

router.put('/clients/:userId/:clientId', auth.requireAuth, async (req, res) => {
  const { userId, clientId } = req.params;
  if (req.user.id !== userId) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const existing = await getClient(clientId);
    if (!existing || existing.user_id !== userId) {
      return res.status(404).json({ error: 'Client not found' });
    }
    await updateClient(clientId, req.body);
    logger.info('Client updated', { userId, clientId });
    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to update client', { userId, clientId, error: error.message });
    res.status(500).json({ error: 'Failed to update client' });
  }
});

router.delete('/clients/:userId/:clientId', auth.requireAuth, async (req, res) => {
  const { userId, clientId } = req.params;
  if (req.user.id !== userId) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    await deleteClient(clientId, userId);
    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to delete client', { userId, clientId, error: error.message });
    res.status(500).json({ error: 'Failed to delete client' });
  }
});

router.get('/clients/:userId/:clientId', auth.requireAuth, async (req, res) => {
  const { userId, clientId } = req.params;
  if (req.user.id !== userId) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const client = await getClient(clientId);
    if (!client || client.user_id !== userId) {
      return res.status(404).json({ error: 'Client not found' });
    }
    const properties = await getPropertiesByClient(clientId);
    const propertiesWithHistory = await Promise.all(
      properties.map(async (prop) => {
        const jobs = await db.getJobsByUser(userId);
        const propertyJobs = jobs.filter((j) => j.address === prop.address);
        return { ...prop, jobs: propertyJobs };
      })
    );
    res.json({ ...client, properties: propertiesWithHistory });
  } catch (error) {
    logger.error('Failed to get client', { userId, clientId, error: error.message });
    res.status(500).json({ error: 'Failed to get client' });
  }
});

// ============= Properties =============

router.get('/properties/:userId', auth.requireAuth, async (req, res) => {
  const { userId } = req.params;
  if (req.user.id !== userId) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const isPaginated = req.query.limit !== undefined || req.query.offset !== undefined;

    if (isPaginated) {
      const { limit, offset } = parsePagination(req.query);
      const { rows, total } = await getPropertiesPaginated(userId, limit, offset);
      res.json(paginatedResponse(rows, total, { limit, offset }));
    } else {
      const properties = await getProperties(userId);
      res.json(properties);
    }
  } catch (error) {
    logger.error('Failed to list properties', { userId, error: error.message });
    res.status(500).json({ error: 'Failed to list properties' });
  }
});

router.post('/properties/:userId', auth.requireAuth, async (req, res) => {
  const { userId } = req.params;
  const { address, postcode, property_type, client_id, notes } = req.body;
  if (req.user.id !== userId) {
    return res.status(403).json({ error: 'Access denied' });
  }
  if (!address || !address.trim()) {
    return res.status(400).json({ error: 'Property address is required' });
  }
  try {
    const property = await createProperty({
      user_id: userId,
      client_id: client_id || null,
      address: address.trim(),
      postcode: postcode || null,
      property_type: property_type || null,
      notes: notes || null,
    });
    logger.info('Property created', { userId, propertyId: property.id });
    res.json(property);
  } catch (error) {
    logger.error('Failed to create property', { userId, error: error.message });
    res.status(500).json({ error: 'Failed to create property' });
  }
});

router.get('/properties/:userId/:propertyId/history', auth.requireAuth, async (req, res) => {
  const { userId, propertyId } = req.params;
  if (req.user.id !== userId) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const allProperties = await getProperties(userId);
    const property = allProperties.find((p) => p.id === propertyId);
    if (!property) {
      return res.status(404).json({ error: 'Property not found' });
    }
    const allJobs = await db.getJobsByUser(userId);
    const propertyJobs = allJobs
      .filter((j) => j.address === property.address)
      .map((j) => ({
        id: j.id,
        address: j.address,
        status: j.status,
        certificate_type: j.certificate_type,
        created_at: j.created_at,
        completed_at: j.completed_at,
      }));
    res.json(propertyJobs);
  } catch (error) {
    logger.error('Failed to get property history', { userId, propertyId, error: error.message });
    res.status(500).json({ error: 'Failed to get property history' });
  }
});

export default router;
