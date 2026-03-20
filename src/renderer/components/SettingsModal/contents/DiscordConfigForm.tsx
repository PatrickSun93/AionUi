/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IChannelPluginStatus, IChannelUser } from '@/channels/types';
import { acpConversation, channel } from '@/common/ipcBridge';
import { ConfigStorage } from '@/common/storage';
import type { GeminiModelSelection } from '@/renderer/pages/conversation/gemini/useGeminiModelSelection';
import type { AcpBackendAll } from '@/types/acpTypes';
import { Button, Dropdown, Empty, Input, Menu, Message, Spin, Tooltip } from '@arco-design/web-react';
import { Delete, Down, Refresh } from '@icon-park/react';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Preference row component (shared with TelegramConfigForm pattern)
 */
const PreferenceRow: React.FC<{
  label: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}> = ({ label, description, children }) => (
  <div className='flex items-center justify-between gap-24px py-12px'>
    <div className='flex-1'>
      <span className='text-14px text-t-primary'>{label}</span>
      {description && <div className='text-12px text-t-tertiary mt-2px'>{description}</div>}
    </div>
    <div className='flex items-center'>{children}</div>
  </div>
);

const SectionHeader: React.FC<{ title: string; action?: React.ReactNode }> = ({ title, action }) => (
  <div className='flex items-center justify-between mb-12px'>
    <h3 className='text-14px font-500 text-t-primary m-0'>{title}</h3>
    {action}
  </div>
);

interface DiscordConfigFormProps {
  pluginStatus: IChannelPluginStatus | null;
  modelSelection?: GeminiModelSelection;
  onStatusChange: (status: IChannelPluginStatus | null) => void;
}

const DiscordConfigForm: React.FC<DiscordConfigFormProps> = ({ pluginStatus, onStatusChange }) => {
  const { t } = useTranslation();

  const [discordToken, setDiscordToken] = useState('');
  const [testLoading, setTestLoading] = useState(false);
  const [usersLoading, setUsersLoading] = useState(false);
  const [authorizedUsers, setAuthorizedUsers] = useState<IChannelUser[]>([]);

  const [availableAgents, setAvailableAgents] = useState<
    Array<{ backend: AcpBackendAll; name: string; customAgentId?: string }>
  >([]);
  const [selectedAgent, setSelectedAgent] = useState<{ backend: AcpBackendAll; name?: string; customAgentId?: string }>(
    { backend: 'gemini' }
  );

  // Load authorized users (filtered to discord platform)
  const loadAuthorizedUsers = useCallback(async () => {
    setUsersLoading(true);
    try {
      const result = await channel.getAuthorizedUsers.invoke();
      if (result.success && result.data) {
        setAuthorizedUsers(result.data.filter((u) => u.platformType === 'discord'));
      }
    } catch (error) {
      console.error('[DiscordConfig] Failed to load authorized users:', error);
    } finally {
      setUsersLoading(false);
    }
  }, []);

  // Load available agents + saved Discord agent selection
  useEffect(() => {
    const load = async () => {
      try {
        const [agentsResp, saved] = await Promise.all([
          acpConversation.getAvailableAgents.invoke(),
          ConfigStorage.get('assistant.discord.agent'),
        ]);

        if (agentsResp.success && agentsResp.data) {
          const list = agentsResp.data
            .filter((a) => !a.isPreset)
            .map((a) => ({ backend: a.backend, name: a.name, customAgentId: a.customAgentId }));
          setAvailableAgents(list);
        }

        if (saved && typeof saved === 'object' && 'backend' in saved && typeof (saved as any).backend === 'string') {
          setSelectedAgent({
            backend: (saved as any).backend as AcpBackendAll,
            customAgentId: (saved as any).customAgentId,
            name: (saved as any).name,
          });
        } else if (typeof saved === 'string') {
          setSelectedAgent({ backend: saved as AcpBackendAll });
        }
      } catch (error) {
        console.error('[DiscordConfig] Failed to load agents:', error);
      }
    };
    void load();
  }, []);

  useEffect(() => {
    void loadAuthorizedUsers();
  }, [loadAuthorizedUsers]);

  // Listen for newly authorized Discord users
  useEffect(() => {
    const unsubscribe = channel.userAuthorized.on((user) => {
      if (user.platformType !== 'discord') return;
      setAuthorizedUsers((prev) => {
        if (prev.some((u) => u.id === user.id)) return prev;
        return [user, ...prev];
      });
    });
    return () => unsubscribe();
  }, []);

  const persistSelectedAgent = async (agent: { backend: AcpBackendAll; customAgentId?: string; name?: string }) => {
    try {
      await ConfigStorage.set('assistant.discord.agent', agent);
      await channel.syncChannelSettings
        .invoke({ platform: 'discord', agent })
        .catch((err) => console.warn('[DiscordConfig] syncChannelSettings failed:', err));
      Message.success(t('settings.assistant.agentSwitched', 'Agent switched successfully'));
    } catch (error) {
      console.error('[DiscordConfig] Failed to save agent:', error);
      Message.error(t('common.saveFailed', 'Failed to save'));
    }
  };

  // Test token and auto-enable on success
  const handleTestConnection = async () => {
    if (!discordToken.trim()) {
      Message.warning(t('settings.assistant.tokenRequired', 'Please enter a bot token'));
      return;
    }

    setTestLoading(true);
    try {
      const result = await channel.testPlugin.invoke({
        pluginId: 'discord_default',
        token: discordToken.trim(),
      });

      if (result.success && result.data?.success) {
        Message.success(
          t('settings.assistant.connectionSuccess', `Connected! Bot: @${result.data.botUsername || 'unknown'}`)
        );
        // Auto-enable after successful test
        const enableResult = await channel.enablePlugin.invoke({
          pluginId: 'discord_default',
          config: { token: discordToken.trim() },
        });
        if (enableResult.success) {
          Message.success(t('settings.discord.pluginEnabled', 'Discord bot enabled'));
          const statusResult = await channel.getPluginStatus.invoke();
          if (statusResult.success && statusResult.data) {
            onStatusChange(statusResult.data.find((p) => p.type === 'discord') || null);
          }
        }
      } else {
        Message.error(result.data?.error || t('settings.assistant.connectionFailed', 'Connection failed'));
      }
    } catch (error: any) {
      Message.error(error.message || t('settings.assistant.connectionFailed', 'Connection failed'));
    } finally {
      setTestLoading(false);
    }
  };

  // Revoke user
  const handleRevokeUser = async (userId: string) => {
    try {
      const result = await channel.revokeUser.invoke({ userId });
      if (result.success) {
        Message.success(t('settings.assistant.userRevoked', 'User access revoked'));
        setAuthorizedUsers((prev) => prev.filter((u) => u.id !== userId));
      } else {
        Message.error(result.msg || t('settings.assistant.revokeFailed', 'Failed to revoke user'));
      }
    } catch (error: any) {
      Message.error(error.message);
    }
  };

  const formatTime = (timestamp: number) => new Date(timestamp).toLocaleString();

  const agentOptions: Array<{ backend: AcpBackendAll; name: string; customAgentId?: string }> =
    availableAgents.length > 0 ? availableAgents : [{ backend: 'gemini', name: 'Gemini CLI' }];

  return (
    <div className='flex flex-col gap-24px'>
      {/* Bot Token */}
      <PreferenceRow
        label={t('settings.assistant.botToken', 'Bot Token')}
        description={t(
          'settings.discord.botTokenDesc',
          'Create a bot at discord.com/developers, enable MESSAGE CONTENT INTENT, then paste your bot token here.'
        )}
      >
        <div className='flex items-center gap-8px'>
          <Input.Password
            value={discordToken}
            onChange={setDiscordToken}
            placeholder={pluginStatus?.hasToken ? '••••••••••••••••' : 'MTxxxxxxxxxxxxxx.Gyyyyy...'}
            style={{ width: 240 }}
            visibilityToggle
          />
          <Button type='outline' loading={testLoading} onClick={handleTestConnection}>
            {t('settings.assistant.testConnection', 'Test')}
          </Button>
        </div>
      </PreferenceRow>

      {/* Agent Selection */}
      <PreferenceRow
        label={t('settings.agent', 'Agent')}
        description={t('settings.discord.agentDesc', 'Used for Discord conversations')}
      >
        <Dropdown
          trigger='click'
          position='br'
          droplist={
            <Menu
              selectedKeys={[
                selectedAgent.customAgentId
                  ? `${selectedAgent.backend}|${selectedAgent.customAgentId}`
                  : selectedAgent.backend,
              ]}
            >
              {agentOptions.map((a) => {
                const key = a.customAgentId ? `${a.backend}|${a.customAgentId}` : a.backend;
                return (
                  <Menu.Item
                    key={key}
                    onClick={() => {
                      const currentKey = selectedAgent.customAgentId
                        ? `${selectedAgent.backend}|${selectedAgent.customAgentId}`
                        : selectedAgent.backend;
                      if (key === currentKey) return;
                      const next = { backend: a.backend, customAgentId: a.customAgentId, name: a.name };
                      setSelectedAgent(next);
                      void persistSelectedAgent(next);
                    }}
                  >
                    {a.name}
                  </Menu.Item>
                );
              })}
            </Menu>
          }
        >
          <Button type='secondary' className='min-w-160px flex items-center justify-between gap-8px'>
            <span className='truncate'>
              {selectedAgent.name ||
                availableAgents.find(
                  (a) =>
                    (a.customAgentId ? `${a.backend}|${a.customAgentId}` : a.backend) ===
                    (selectedAgent.customAgentId
                      ? `${selectedAgent.backend}|${selectedAgent.customAgentId}`
                      : selectedAgent.backend)
                )?.name ||
                selectedAgent.backend}
            </span>
            <Down theme='outline' size={14} />
          </Button>
        </Dropdown>
      </PreferenceRow>

      {/* Setup instructions — shown after bot connects but before any authorized users */}
      {pluginStatus?.enabled && pluginStatus?.connected && authorizedUsers.length === 0 && (
        <div className='bg-blue-50 dark:bg-blue-900/20 rd-12px p-16px border border-blue-200 dark:border-blue-800'>
          <SectionHeader title={t('settings.assistant.nextSteps', 'Next Steps')} />
          <div className='text-14px text-t-secondary space-y-8px'>
            <p className='m-0'>
              <strong>1.</strong>{' '}
              {t('settings.discord.step1', 'Invite your bot to a server or open a DM with it in Discord.')}
              {pluginStatus.botUsername && (
                <span className='ml-4px'>
                  <code className='bg-fill-2 px-6px py-2px rd-4px'>@{pluginStatus.botUsername}</code>
                </span>
              )}
            </p>
            <p className='m-0'>
              <strong>2.</strong> {t('settings.discord.step2', '@mention the bot or send it a DM to start pairing.')}
            </p>
            <p className='m-0'>
              <strong>3.</strong>{' '}
              {t(
                'settings.discord.step3',
                'The bot will reply with a pairing code. Come back here and click "Approve" to authorize yourself.'
              )}
            </p>
            <p className='m-0'>
              <strong>4.</strong>{' '}
              {t(
                'settings.discord.step4',
                'Once approved, @mention the bot with your task and it will respond with the result!'
              )}
            </p>
          </div>
        </div>
      )}

      {/* Authorized Users */}
      {authorizedUsers.length > 0 && (
        <div className='bg-fill-1 rd-12px pt-16px pr-16px pb-16px pl-0'>
          <SectionHeader
            title={t('settings.assistant.authorizedUsers', 'Authorized Users')}
            action={
              <Button
                size='mini'
                type='text'
                icon={<Refresh size={14} />}
                loading={usersLoading}
                onClick={loadAuthorizedUsers}
              >
                {t('common.refresh', 'Refresh')}
              </Button>
            }
          />

          {usersLoading ? (
            <div className='flex justify-center py-24px'>
              <Spin />
            </div>
          ) : authorizedUsers.length === 0 ? (
            <Empty description={t('settings.assistant.noAuthorizedUsers', 'No authorized users yet')} />
          ) : (
            <div className='flex flex-col gap-12px'>
              {authorizedUsers.map((user) => (
                <div key={user.id} className='flex items-center justify-between bg-fill-2 rd-8px p-12px'>
                  <div className='flex-1'>
                    <div className='text-14px font-500 text-t-primary'>{user.displayName || 'Unknown User'}</div>
                    <div className='text-12px text-t-tertiary mt-4px'>
                      {t('settings.assistant.platform', 'Platform')}: Discord
                      <span className='mx-8px'>|</span>
                      {t('settings.assistant.authorizedAt', 'Authorized')}: {formatTime(user.authorizedAt)}
                    </div>
                  </div>
                  <Tooltip content={t('settings.assistant.revokeAccess', 'Revoke access')}>
                    <Button
                      type='text'
                      status='danger'
                      size='small'
                      icon={<Delete size={16} />}
                      onClick={() => handleRevokeUser(user.id)}
                    />
                  </Tooltip>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default DiscordConfigForm;
