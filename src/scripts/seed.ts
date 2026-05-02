import 'dotenv/config';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

// Minimal inline models to avoid circular imports
const userSchema = new mongoose.Schema({
  email: String, passwordHash: String, name: String,
  role: { type: String, default: 'super_admin' },
  emailVerified: { type: Boolean, default: true },
  defaultWorkspaceId: mongoose.Schema.Types.ObjectId,
  createdAt: { type: Date, default: Date.now },
}, { timestamps: true });

const workspaceSchema = new mongoose.Schema({
  name: String, slug: String,
  ownerId: mongoose.Schema.Types.ObjectId,
  members: [{ userId: mongoose.Schema.Types.ObjectId, role: String, invitedAt: Date, acceptedAt: Date }],
  plan: { type: String, default: 'free' },
  credits: { type: Number, default: 1000 },
  creditAllowance: { type: Number, default: 1000 },
  currency: { type: String, default: 'USD' },
  taxRate: { type: Number, default: 0 },
  status: { type: String, default: 'active' },
}, { timestamps: true });

const User = mongoose.model('User', userSchema);
const Workspace = mongoose.model('Workspace', workspaceSchema);

async function seed() {
  const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/meterflow';
  await mongoose.connect(MONGO_URI);
  console.log('✅ Connected to MongoDB');

  // ── Super Admin ───────────────────────────────────────────────────
  const adminEmail = process.env.SEED_ADMIN_EMAIL || 'admin@meterflow.dev';
  const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'Admin1234!';
  const adminName = 'MeterFlow Admin';

  const existingAdmin = await User.findOne({ email: adminEmail });
  if (existingAdmin) {
    console.log(`ℹ️  Super admin already exists: ${adminEmail}`);
  } else {
    const passwordHash = await bcrypt.hash(adminPassword, 12);

    const workspace = await Workspace.create({
      name: 'Admin Workspace',
      slug: 'admin-workspace',
      ownerId: new mongoose.Types.ObjectId(), // temp
      plan: 'enterprise',
      credits: 5_000_000,
      creditAllowance: 5_000_000,
      members: [],
    });

    const admin = await User.create({
      email: adminEmail,
      passwordHash,
      name: adminName,
      role: 'super_admin',
      emailVerified: true,
      defaultWorkspaceId: workspace._id,
    });

    await Workspace.updateOne(
      { _id: workspace._id },
      {
        $set: { ownerId: admin._id },
        $push: { members: { userId: admin._id, role: 'owner', invitedAt: new Date(), acceptedAt: new Date() } },
      }
    );

    await User.updateOne({ _id: admin._id }, { $set: { defaultWorkspaceId: workspace._id } });

    console.log(`✅ Super admin created:`);
    console.log(`   Email   : ${adminEmail}`);
    console.log(`   Password: ${adminPassword}`);
    console.log(`   Role    : super_admin`);
  }

  // ── Demo workspace ────────────────────────────────────────────────
  const demoEmail = process.env.SEED_DEMO_EMAIL || 'demo@meterflow.dev';
  const demoPassword = process.env.SEED_DEMO_PASSWORD || 'Demo1234!';

  const existingDemo = await User.findOne({ email: demoEmail });
  if (existingDemo) {
    console.log(`ℹ️  Demo user already exists: ${demoEmail}`);
  } else {
    const passwordHash = await bcrypt.hash(demoPassword, 12);

    const demoWorkspace = await Workspace.create({
      name: 'Demo Workspace',
      slug: 'demo-workspace',
      ownerId: new mongoose.Types.ObjectId(),
      plan: 'pro',
      credits: 500_000,
      creditAllowance: 500_000,
      members: [],
    });

    const demoUser = await User.create({
      email: demoEmail,
      passwordHash,
      name: 'Demo User',
      role: 'api_owner',
      emailVerified: true,
      defaultWorkspaceId: demoWorkspace._id,
    });

    await Workspace.updateOne(
      { _id: demoWorkspace._id },
      {
        $set: { ownerId: demoUser._id },
        $push: { members: { userId: demoUser._id, role: 'owner', invitedAt: new Date(), acceptedAt: new Date() } },
      }
    );

    console.log(`✅ Demo user created:`);
    console.log(`   Email   : ${demoEmail}`);
    console.log(`   Password: ${demoPassword}`);
  }

  await mongoose.disconnect();
  console.log('\n🌱 Seed complete.');
  process.exit(0);
}

seed().catch((err) => {
  console.error('❌ Seed failed:', err);
  process.exit(1);
});
