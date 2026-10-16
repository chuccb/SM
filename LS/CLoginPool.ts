import { CRateLimiter } from "../Common/CRateLimiter.ts";
import { RuntimePolicy } from "../Common/RuntimePolicy.ts";
import { CUserPool } from "../Common/CUserPool.ts";
import type { CClientSocket } from "../Common/CClientSocket.ts";
import type { CReceivedPacketBase } from "../Common/CReceivedPacketBase.ts";
import type { CDBMan } from "./CDBMan.ts";
import { CSendPacket } from "../Common/CSendPacket.ts";
import { CProtocolError } from "../Common/CProtocolError.ts";
import {
  LoginResult,
  LoginStringKey,
  UserCount,
  UserFieldSize,
  OpaqueOfficial,
  LoginFlushIntervalMs,
  FirstInfoURL,
} from "../Common/OfficialValues.ts";
import {
  ClientRequest,
  ServerResponse,
} from "../Common/Protocol/PacketTypes.ts";
import { IPv4Number } from "../Common/CIPAddress.ts";
import { CCenterProcess } from "../Common/CCenterProcess.ts";
import type { CMultiServer } from "./CMultiServer.ts";
import type { CChannelCache } from "./CChannelCache.ts";
import type { CConfigDyn } from "./CConfigDyn.ts";
import type { ServerConfig } from "../Common/CServerConfig.ts";
import type { NewUserFields } from "../Common/DB/Rows.ts";

export class CLoginPool extends CUserPool {
  private readonly registrations = new CRateLimiter(
    RuntimePolicy.MaxAccountsPerMinutePerIP,
    60_000,
    RuntimePolicy.MaxConnectionsPerService,
  );
  constructor(
    readonly db: CDBMan,
    readonly center: CCenterProcess,
    readonly multi: CMultiServer,
    readonly channels: CChannelCache,
    readonly dyn: CConfigDyn,
    readonly config: ServerConfig,
  ) {
    super();
  }
  override async OnPacket(
    packet: CReceivedPacketBase,
    socket: CClientSocket,
  ): Promise<void> {
    switch (packet.Decode1()) {
      case ClientRequest.AskMultiServer:
        this.OnAskMultiServer(packet, socket);
        return;
      case ClientRequest.AskFirstInfo:
        this.OnAskFirstInfo(packet, socket);
        return;
      case ClientRequest.Login:
        await this.OnLogin(packet, socket);
        return;
      case ClientRequest.NewUserConfirmId:
        this.OnNewUserConfirmId(packet, socket);
        return;
      case ClientRequest.NewUser:
        await this.OnNewUser(packet, socket);
        return;
      case ClientRequest.ReqConnectToSvr:
        this.OnReqConnectToSvr(packet, socket);
        return;
      case ClientRequest.ConnEstablished:
        throw new CProtocolError(
          "Login server cannot handle kcConnEstablished",
        );
      case ClientRequest.RequestEnterChannelStage:
        this.OnRequestEnterChannelStage(packet, socket);
        return;
      // The original unprivileged destroy-service/crash handlers are deliberately not exposed.
      default:
        packet.Rewind();
        await super.OnPacket(packet, socket);
    }
  }
  OnAskMultiServer(packet: CReceivedPacketBase, socket: CClientSocket): void {
    const hash = packet.Decode4();
    packet.Decode4();
    packet.AssertEnd();
    socket.SendPacket(
      this.multi.GetInfoPacket(hash !== this.multi.GetHashValue()),
    );
  }
  OnAskFirstInfo(packet: CReceivedPacketBase, socket: CClientSocket): void {
    const hash = packet.Decode4();
    packet.AssertEnd();
    const out = new CSendPacket(
      ServerResponse.FirstInfo,
      undefined,
      socket.text,
    );
    if (hash === 0)
      out.EncodeStr(FirstInfoURL.ConfirmUser).EncodeStr(FirstInfoURL.IDQuery);
    socket.SendPacket(out);
  }
  async OnLogin(
    packet: CReceivedPacketBase,
    socket: CClientSocket,
  ): Promise<void> {
    const count = packet.Decode1();
    if (
      count < UserCount.Minimum ||
      count > UserCount.Maximum ||
      socket.GetUserCount()
    )
      throw new CProtocolError("Invalid login player count/state");
    // Original anti-flush window is 5000 ms. Per-connection serialization prevents overlap.
    if (Date.now() - socket.m_nLastLogin < LoginFlushIntervalMs)
      throw new CProtocolError("Login flush", "rate-limit");
    socket.m_nLastLogin = Date.now();
    const credentials: { id: string; password: string }[] = [];
    for (let i = 0; i < count; i++)
      credentials.push({
        id: packet.DecodeEncryptedStr(LoginStringKey.ID, UserFieldSize.ID),
        password: packet.DecodeEncryptedStr(LoginStringKey.Password, 128),
      });
    socket.m_nConfigHash = packet.Decode4();
    packet.AssertEnd();
    const accounts = [];
    for (const [i, credential] of credentials.entries()) {
      const account = await this.db.InitUser(
        credential.id,
        credential.password,
      );
      credential.password = "";
      if (!socket.IsConnected()) return;
      if (!account) {
        socket.SendPacket(
          new CSendPacket(ServerResponse.Login, undefined, socket.text)
            .Encode1(LoginResult.InvalidCredentials)
            .Encode1(i),
        );
        return;
      }
      accounts.push(account);
    }
    try {
      this.center.RegisterConnection(socket, accounts);
    } catch (error) {
      if (
        !(error instanceof CProtocolError) ||
        error.code !== "already-connected"
      )
        throw error;
      socket.SendPacket(
        new CSendPacket(ServerResponse.Login, undefined, socket.text).Encode1(
          LoginResult.AlreadyConnected,
        ),
      );
      return;
    }
    this.OnCenterResAddNewUser(socket);
  }
  OnCenterResAddNewUser(socket: CClientSocket): void {
    const out = new CSendPacket(ServerResponse.Login, undefined, socket.text)
      .Encode1(LoginResult.Success)
      .Encode2(1)
      .EncodeStr("")
      .Encode1(socket.GetUserCount());
    for (const user of socket.m_aUser) {
      const info = user.m_userInfo;
      out
        .Encode4(user.GetGlobalSerialNo())
        .EncodeStr(user.GetName())
        .Encode1(info.Gender)
        .Encode2(OpaqueOfficial.LoginUserWord)
        .Encode1(OpaqueOfficial.LoginUserByteA)
        .Encode1(OpaqueOfficial.LoginUserByteB)
        .Encode2(user.GetLevel())
        .Encode4(info.Money)
        .Encode4(info.GuildSn)
        .Encode1(0)
        .EncodeStr(info.Email)
        // Personal identification/age verification is deliberately not fabricated.
        .Encode1(2)
        .Encode1(2)
        .Encode4(user.GetAuthencode());
    }
    out.EncodeStr("");
    socket.SendPacket(out);
    if (socket.m_nConfigHash !== this.dyn.GetNoticeHash())
      socket.SendPacket(this.dyn.GetNoticePacket());
  }
  OnNewUserConfirmId(packet: CReceivedPacketBase, socket: CClientSocket): void {
    const id = packet.DecodeStr(UserFieldSize.ID);
    packet.AssertEnd();
    socket.SendPacket(
      new CSendPacket(
        ServerResponse.NewUserConfirmId,
        undefined,
        socket.text,
      ).Encode1(this.db.ConfirmUnregisteredId(id)),
    );
  }
  async OnNewUser(
    packet: CReceivedPacketBase,
    socket: CClientSocket,
  ): Promise<void> {
    if (
      !this.config.Runtime.Registration ||
      socket.GetUserCount() ||
      !this.registrations.Admit(socket.address)
    ) {
      socket.SendPacket(
        new CSendPacket(ServerResponse.NewUser, undefined, socket.text).Encode1(
          1,
        ),
      );
      return;
    }
    const fields: NewUserFields = {
      ID: packet.DecodeStr(UserFieldSize.ID),
      Password: packet.DecodeStr(128),
      PasswordQ: packet.DecodeStr(UserFieldSize.PasswordQ),
      PasswordA: packet.DecodeStr(UserFieldSize.PasswordA),
      IdentityNo: packet.DecodeStr(UserFieldSize.IdentityNo),
      Birthday: packet.DecodeStr(UserFieldSize.Birthday),
      Name: packet.DecodeStr(UserFieldSize.Name),
      Email: packet.DecodeStr(UserFieldSize.Email),
      EmailRcv: packet.Decode1(),
      Gender: packet.Decode1(),
      Address: packet.DecodeStr(UserFieldSize.Address),
      Tel: packet.DecodeStr(UserFieldSize.Tel),
      Profile: packet.DecodeStr(UserFieldSize.Profile),
      Reveal: packet.Decode1(),
    };
    packet.AssertEnd();
    let code = 0;
    try {
      await this.db.RegisterNewUser(fields);
    } catch {
      code = 1;
    } finally {
      fields.Password = "";
    }
    socket.SendPacket(
      new CSendPacket(ServerResponse.NewUser, undefined, socket.text).Encode1(
        code,
      ),
    );
  }
  OnReqConnectToSvr(packet: CReceivedPacketBase, socket: CClientSocket): void {
    this.RequireAuthenticated(socket);
    const type = packet.Decode1();
    const index = packet.Decode4();
    packet.Decode2();
    packet.AssertEnd();
    const response = this.center.RequestConnection(socket, type, index);
    const out = new CSendPacket(
      ServerResponse.ConnectToSvr,
      undefined,
      socket.text,
    ).Encode1(response.result);
    if (response.server)
      out
        .Encode1(response.server.m_nServerType)
        .Encode4(response.server.m_nIdx)
        .Encode4(IPv4Number(this.config.Runtime.AdvertisedIP))
        .Encode2(response.server.m_nListenPort);
    socket.SendPacket(out);
  }
  OnRequestEnterChannelStage(
    packet: CReceivedPacketBase,
    socket: CClientSocket,
  ): void {
    this.RequireAuthenticated(socket);
    const hash = packet.Decode4();
    packet.AssertEnd();
    socket.SendPacket(
      this.channels.GetInfoPacket(hash !== this.channels.GetHashValue()),
    );
    socket.SendPacket(this.channels.GetStatePacket());
    socket.SendPacket(this.channels.MakeChannelsGameStatePacket());
    socket.SendPacket(this.channels.MakeChannelsExtraInfoPacket());
  }
}
